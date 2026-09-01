import { useEffect, useRef, useState } from 'react'
import logo from './assets/isotec-logo.png'
import Viewer, { type ViewerFoto } from './Viewer'
import { bereiteBildVor, blobZuBase64 } from './lib/bild'
import { GeminiFehler, saniereFoto } from './lib/gemini'
import {
  leseSchluessel,
  speichereSchluessel,
  uebernimmSchluesselAusLink,
  verteilLink,
} from './lib/schluessel'

type Status = 'liest' | 'wartet' | 'laeuft' | 'fertig' | 'fehler'

type Foto = {
  id: string
  name: string
  vorherUrl: string
  vorherBlob: Blob
  nachherUrl?: string
  nachherBlob?: Blob
  status: Status
  fehler?: string
}

/**
 * Hoechstens zwei Anfragen gleichzeitig an Gemini: schont das Kontingent des
 * Schluessels (429) und haelt das Geraet fluessig.
 */
let aktiveAnfragen = 0
const anfrageWarteschlange: Array<() => void> = []
async function mitPlatz<T>(arbeit: () => Promise<T>): Promise<T> {
  if (aktiveAnfragen >= 2) await new Promise<void>((frei) => anfrageWarteschlange.push(frei))
  aktiveAnfragen++
  try {
    return await arbeit()
  } finally {
    aktiveAnfragen--
    anfrageWarteschlange.shift()?.()
  }
}

let naechsteId = 1
let demoGeladen = false

export default function App() {
  const [fotos, setFotos] = useState<Foto[]>([])
  const [schluessel, setSchluessel] = useState('')
  const [einstellungenOffen, setEinstellungenOffen] = useState(false)
  const [schluesselEntwurf, setSchluesselEntwurf] = useState('')
  const [linkKopiert, setLinkKopiert] = useState(false)
  const [zeigeIndex, setZeigeIndex] = useState<number | null>(null)
  const [ziehtDatei, setZiehtDatei] = useState(false)
  const dateiFeld = useRef<HTMLInputElement>(null)
  const schluesselRef = useRef('')
  schluesselRef.current = schluessel

  useEffect(() => {
    const demo = window.location.hash.includes('demo')
    const wert = uebernimmSchluesselAusLink() || leseSchluessel()
    setSchluessel(wert)
    setSchluesselEntwurf(wert)
    if (demo && !demoGeladen) {
      demoGeladen = true
      void (async () => {
        const { demoBilder } = await import('./lib/demo')
        const { vorher, nachher } = await demoBilder()
        setFotos((liste) => [
          ...liste,
          {
            id: `demo-${naechsteId++}`,
            name: 'Beispiel Kellerwand',
            vorherUrl: URL.createObjectURL(vorher),
            vorherBlob: vorher,
            nachherUrl: URL.createObjectURL(nachher),
            nachherBlob: nachher,
            status: 'fertig',
          },
        ])
      })()
    }
  }, [])

  function aktualisiere(id: string, aenderung: Partial<Foto>) {
    setFotos((liste) => liste.map((f) => (f.id === id ? { ...f, ...aenderung } : f)))
  }

  /** Schickt ein Foto an Gemini; ein wiederholbarer Fehler bekommt einen zweiten Versuch. */
  async function verarbeite(id: string, vorherBlob: Blob) {
    if (!schluesselRef.current) {
      aktualisiere(id, { status: 'wartet' })
      return
    }
    aktualisiere(id, { status: 'laeuft', fehler: undefined })
    try {
      const base64 = await blobZuBase64(vorherBlob)
      const nachherBlob = await mitPlatz(async () => {
        try {
          return await saniereFoto(base64, schluesselRef.current)
        } catch (fehler) {
          if (fehler instanceof GeminiFehler && fehler.wiederholbar) {
            await new Promise((r) => setTimeout(r, 4000))
            return await saniereFoto(base64, schluesselRef.current)
          }
          throw fehler
        }
      })
      aktualisiere(id, {
        status: 'fertig',
        nachherBlob,
        nachherUrl: URL.createObjectURL(nachherBlob),
      })
    } catch (fehler) {
      aktualisiere(id, {
        status: 'fehler',
        fehler: fehler instanceof Error ? fehler.message : 'Unbekannter Fehler',
      })
    }
  }

  async function nimmDateien(dateien: FileList | File[]) {
    for (const datei of Array.from(dateien)) {
      if (!datei.type.startsWith('image/') && !/\.(heic|heif)$/i.test(datei.name)) continue
      const id = String(naechsteId++)
      const name = datei.name.replace(/\.[^.]+$/, '')
      setFotos((liste) => [
        ...liste,
        { id, name, vorherUrl: '', vorherBlob: datei, status: 'liest' },
      ])
      try {
        const { blob } = await bereiteBildVor(datei)
        const vorherUrl = URL.createObjectURL(blob)
        aktualisiere(id, { vorherBlob: blob, vorherUrl })
        void verarbeite(id, blob)
      } catch {
        aktualisiere(id, { status: 'fehler', fehler: 'Foto konnte nicht gelesen werden.' })
      }
    }
  }

  function entferne(id: string) {
    setFotos((liste) => {
      const foto = liste.find((f) => f.id === id)
      if (foto?.vorherUrl) URL.revokeObjectURL(foto.vorherUrl)
      if (foto?.nachherUrl) URL.revokeObjectURL(foto.nachherUrl)
      return liste.filter((f) => f.id !== id)
    })
  }

  function speichereEinstellungen() {
    const wert = schluesselEntwurf.trim()
    speichereSchluessel(wert)
    setSchluessel(wert)
    setEinstellungenOffen(false)
    // Alles, was auf den Schluessel gewartet hat, jetzt anstossen.
    if (wert) {
      schluesselRef.current = wert
      for (const foto of fotos) {
        if (foto.status === 'wartet') void verarbeite(foto.id, foto.vorherBlob)
      }
    }
  }

  async function kopiereVerteilLink() {
    try {
      await navigator.clipboard.writeText(verteilLink(schluessel))
      setLinkKopiert(true)
      window.setTimeout(() => setLinkKopiert(false), 2500)
    } catch {
      /* Zwischenablage nicht verfuegbar */
    }
  }

  const fertige: ViewerFoto[] = fotos
    .filter((f) => f.status === 'fertig' && f.nachherUrl && f.nachherBlob)
    .map((f) => ({
      id: f.id,
      name: f.name,
      vorherUrl: f.vorherUrl,
      nachherUrl: f.nachherUrl!,
      nachherBlob: f.nachherBlob!,
    }))

  return (
    <>
      <header className="header">
        <div className="container header-inner">
          <div className="header-brand">
            <img className="header-logo" src={logo} alt="ISOTEC" />
            <div className="header-divider" />
            <div>
              <h1>Keller Vorher-Nachher</h1>
              <p className="header-kicker">Sanierungsvorschau mit KI</p>
            </div>
          </div>
          <button
            className="btn btn-rand"
            onClick={() => {
              setSchluesselEntwurf(schluessel)
              setEinstellungenOffen((o) => !o)
            }}
          >
            <span className={schluessel ? 'punkt punkt-ok' : 'punkt punkt-warn'} />
            Einstellungen
          </button>
        </div>
      </header>

      <main className="container">
        {einstellungenOffen && (
          <section className="card">
            <h2>Einstellungen</h2>
            <p className="section-hint">
              Das Tool braucht einen Google-Gemini-API-Schlüssel (einmal je Gerät). Anlegen unter{' '}
              <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
                aistudio.google.com/apikey
              </a>
              . Kosten: etwa 4 Cent je Foto. Der Schlüssel bleibt auf diesem Gerät gespeichert.
            </p>
            <div className="zeile">
              <input
                className="feld"
                type="text"
                inputMode="text"
                autoComplete="off"
                spellCheck={false}
                placeholder="API-Schlüssel einfügen"
                value={schluesselEntwurf}
                onChange={(e) => setSchluesselEntwurf(e.target.value)}
              />
              <button className="btn btn-rot" onClick={speichereEinstellungen}>
                Speichern
              </button>
            </div>
            {schluessel && (
              <p className="section-hint" style={{ marginTop: 12 }}>
                Für die Kollegen:{' '}
                <button className="btn btn-rand btn-klein" onClick={kopiereVerteilLink}>
                  {linkKopiert ? '✓ Link kopiert' : 'Link mit Schlüssel kopieren'}
                </button>{' '}
                Wer den Link einmal öffnet, hat den Schlüssel automatisch hinterlegt.
              </p>
            )}
          </section>
        )}

        {!schluessel && !einstellungenOffen && (
          <section className="card hinweis-warn">
            Es ist noch kein API-Schlüssel hinterlegt. Fotos können hochgeladen werden, die
            Bearbeitung startet aber erst, wenn unter <strong>Einstellungen</strong> ein
            Gemini-Schlüssel gespeichert ist.
          </section>
        )}

        <section className="card">
          <h2>
            <span className="step">1</span>Kellerfotos hochladen
          </h2>
          <div
            className={ziehtDatei ? 'ablage zieht' : 'ablage'}
            onDragOver={(e) => {
              e.preventDefault()
              setZiehtDatei(true)
            }}
            onDragLeave={() => setZiehtDatei(false)}
            onDrop={(e) => {
              e.preventDefault()
              setZiehtDatei(false)
              void nimmDateien(e.dataTransfer.files)
            }}
            onClick={() => dateiFeld.current?.click()}
          >
            <p>
              <strong>Fotos auswählen</strong> oder hierher ziehen
            </p>
            <p className="ablage-klein">
              Jedes Foto wird automatisch bearbeitet: Wände und Decke erscheinen frisch saniert und
              weiß. Zur Bearbeitung wird das Foto an Google (Gemini) übertragen; das Tool selbst
              speichert nichts.
            </p>
          </div>
          <input
            ref={dateiFeld}
            type="file"
            accept="image/*,.heic,.heif"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) void nimmDateien(e.target.files)
              e.target.value = ''
            }}
          />
        </section>

        {fotos.length > 0 && (
          <section className="card">
            <h2>
              <span className="step">2</span>Übersicht
            </h2>
            <p className="section-hint">
              Fertige Fotos antippen für den großen Vorher-Nachher-Vergleich.
            </p>
            <div className="galerie">
              {fotos.map((foto) => {
                const fertigIndex = fertige.findIndex((f) => f.id === foto.id)
                return (
                  <figure
                    key={foto.id}
                    className={foto.status === 'fertig' ? 'kachel klickbar' : 'kachel'}
                    onClick={() => {
                      if (fertigIndex >= 0) setZeigeIndex(fertigIndex)
                    }}
                  >
                    <div className="kachel-bild">
                      {foto.vorherUrl && <img src={foto.vorherUrl} alt={`${foto.name} vorher`} />}
                      {foto.status === 'fertig' && foto.nachherUrl && (
                        <>
                          <img
                            src={foto.nachherUrl}
                            alt={`${foto.name} nachher`}
                            style={{ clipPath: 'inset(0 0 0 50%)' }}
                          />
                          <span className="kachel-teiler" />
                        </>
                      )}
                      {(foto.status === 'laeuft' || foto.status === 'liest') && (
                        <span className="kachel-schleier">
                          <span className="dreher" />
                          {foto.status === 'laeuft' ? 'Wird saniert …' : 'Wird gelesen …'}
                        </span>
                      )}
                      {foto.status === 'wartet' && (
                        <span className="kachel-schleier">Wartet auf Schlüssel</span>
                      )}
                      {foto.status === 'fehler' && (
                        <span className="kachel-schleier kachel-fehler">
                          {foto.fehler}
                          <button
                            className="btn btn-hell btn-klein"
                            onClick={(e) => {
                              e.stopPropagation()
                              void verarbeite(foto.id, foto.vorherBlob)
                            }}
                          >
                            Erneut versuchen
                          </button>
                        </span>
                      )}
                    </div>
                    <figcaption>
                      <span className="kachel-name" title={foto.name}>
                        {foto.name}
                      </span>
                      <button
                        className="kachel-entfernen"
                        aria-label="Foto entfernen"
                        onClick={(e) => {
                          e.stopPropagation()
                          entferne(foto.id)
                        }}
                      >
                        ✕
                      </button>
                    </figcaption>
                  </figure>
                )
              })}
            </div>
            <p className="rechts-hinweis">
              Die Nachher-Bilder sind KI-Visualisierungen zur Veranschaulichung, kein zugesichertes
              Sanierungsergebnis.
            </p>
          </section>
        )}
      </main>

      <footer className="fusszeile">
        Abdichtungstechnik Dipl.-Ing. Morscheck GmbH · Läuft vollständig im Browser, keine Anmeldung
      </footer>

      {zeigeIndex !== null && fertige[zeigeIndex] && (
        <Viewer
          fotos={fertige}
          index={zeigeIndex}
          onIndex={setZeigeIndex}
          onClose={() => setZeigeIndex(null)}
        />
      )}
    </>
  )
}
