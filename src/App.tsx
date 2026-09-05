import { useEffect, useRef, useState } from 'react'
import logo from './assets/isotec-logo.png'
import Vergleich from './Vergleich'
import Viewer, { type ViewerFoto } from './Viewer'
import { ladeNachherHerunter, teileNachherBild, teilenMoeglich } from './lib/share'
import { bereiteBildVor, blobZuBase64 } from './lib/bild'
import { GeminiFehler, saniereFoto } from './lib/gemini'
import {
  MITGELIEFERTER_SCHLUESSEL,
  leseEigenenSchluessel,
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
  /** true, wenn das Nachher-Bild mit Skizze erzeugt wurde. */
  mitSkizze?: boolean
}

/**
 * Die Skizze mit den umrandeten Sanierungsbereichen, gilt fuer alle Fotos.
 * Ein Bild oder ein PDF; jede PDF-Seite wird zu einem eigenen Bild.
 */
type Skizze = { urls: string[]; base64: string[]; name: string }

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
  const [eigener, setEigener] = useState('')
  const [linkKopiert, setLinkKopiert] = useState(false)
  const [auswahlId, setAuswahlId] = useState<string | null>(null)
  const [gesichert, setGesichert] = useState(false)
  const [zeigeIndex, setZeigeIndex] = useState<number | null>(null)
  const [ziehtDatei, setZiehtDatei] = useState(false)
  const [skizze, setSkizze] = useState<Skizze | null>(null)
  const dateiFeld = useRef<HTMLInputElement>(null)
  const skizzeFeld = useRef<HTMLInputElement>(null)
  const schluesselRef = useRef('')
  schluesselRef.current = schluessel
  // Die Skizze muss auch in laufenden Verarbeitungen die aktuelle sein.
  const skizzeRef = useRef<string[]>([])
  skizzeRef.current = skizze?.base64 ?? []

  useEffect(() => {
    const demo = window.location.hash.includes('demo')
    // Die Einstellungen stehen absichtlich nicht in der Oberfläche: Im Einsatz
    // soll niemand am Schlüssel drehen. Erreichbar nur über #einstellungen.
    const einstellungen = window.location.hash.includes('einstellungen')
    uebernimmSchluesselAusLink()
    setSchluessel(leseSchluessel())
    setEigener(leseEigenenSchluessel())
    setSchluesselEntwurf(leseEigenenSchluessel())
    if (einstellungen) setEinstellungenOffen(true)
    if (demo && !demoGeladen) {
      demoGeladen = true
      void (async () => {
        const { demoBilder } = await import('./lib/demo')
        const namen = ['Beispiel Waschküche', 'Beispiel Kellerflur', 'Beispiel Heizungsraum']
        for (const [nummer, name] of namen.entries()) {
          const { vorher, nachher } = await demoBilder(nummer)
          setFotos((liste) => [
            ...liste,
            {
              id: `demo-${naechsteId++}`,
              name,
              vorherUrl: URL.createObjectURL(vorher),
              vorherBlob: vorher,
              nachherUrl: URL.createObjectURL(nachher),
              nachherBlob: nachher,
              status: 'fertig',
            },
          ])
        }
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
    const mitSkizze = skizzeRef.current.length > 0
    try {
      const base64 = await blobZuBase64(vorherBlob)
      const nachherBlob = await mitPlatz(async () => {
        try {
          return await saniereFoto(base64, schluesselRef.current, skizzeRef.current.length ? skizzeRef.current : undefined)
        } catch (fehler) {
          if (fehler instanceof GeminiFehler && fehler.wiederholbar) {
            await new Promise((r) => setTimeout(r, 4000))
            return await saniereFoto(base64, schluesselRef.current, skizzeRef.current.length ? skizzeRef.current : undefined)
          }
          // Ein auf diesem Geraet hinterlegter Schluessel, den Google ablehnt
          // (z. B. der gesperrte vom 04.09.2026), wird verworfen; danach gilt
          // wieder der mitgelieferte, und der Versuch wird damit wiederholt.
          if (
            fehler instanceof GeminiFehler &&
            fehler.schluesselAbgelehnt &&
            leseEigenenSchluessel() &&
            MITGELIEFERTER_SCHLUESSEL &&
            schluesselRef.current !== MITGELIEFERTER_SCHLUESSEL
          ) {
            speichereSchluessel('')
            setEigener('')
            setSchluesselEntwurf('')
            setSchluessel(MITGELIEFERTER_SCHLUESSEL)
            schluesselRef.current = MITGELIEFERTER_SCHLUESSEL
            return await saniereFoto(base64, MITGELIEFERTER_SCHLUESSEL, skizzeRef.current.length ? skizzeRef.current : undefined)
          }
          throw fehler
        }
      })
      aktualisiere(id, {
        status: 'fertig',
        nachherBlob,
        nachherUrl: URL.createObjectURL(nachherBlob),
        mitSkizze,
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

  /** Nimmt die Skizze mit den umrandeten Bereichen an; sie gilt fuer alle Fotos. */
  async function nimmSkizze(datei: File) {
    try {
      const { ladeSkizze } = await import('./lib/skizze')
      const blobs = await ladeSkizze(datei)
      const base64 = await Promise.all(blobs.map(blobZuBase64))
      setSkizze((alt) => {
        alt?.urls.forEach((u) => URL.revokeObjectURL(u))
        return {
          urls: blobs.map((b) => URL.createObjectURL(b)),
          base64,
          name: datei.name.replace(/\.[^.]+$/, ''),
        }
      })
    } catch (fehler) {
      window.alert(
        fehler instanceof Error && fehler.message
          ? `Die Skizze konnte nicht gelesen werden: ${fehler.message}`
          : 'Die Skizze konnte nicht gelesen werden.',
      )
    }
  }

  function entferneSkizze() {
    setSkizze((alt) => {
      alt?.urls.forEach((u) => URL.revokeObjectURL(u))
      return null
    })
  }

  /** Ein fertiges oder gescheitertes Foto noch einmal bearbeiten, z. B. nach Aendern der Skizze. */
  function bearbeiteErneut(foto: Foto) {
    if (foto.nachherUrl) URL.revokeObjectURL(foto.nachherUrl)
    aktualisiere(foto.id, { nachherUrl: undefined, nachherBlob: undefined, mitSkizze: undefined })
    void verarbeite(foto.id, foto.vorherBlob)
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
    const eingabe = schluesselEntwurf.trim()
    speichereSchluessel(eingabe)
    setEigener(eingabe)
    // Ohne eigene Eingabe gilt wieder der mitgelieferte Schluessel.
    const wert = eingabe || MITGELIEFERTER_SCHLUESSEL
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

  // Immer ein Foto im Vergleichsfenster zeigen: das zuletzt gewaehlte, sonst
  // das erste fertige. Wird das gewaehlte entfernt, rueckt automatisch nach.
  const gewaehlt = fertige.find((f) => f.id === auswahlId) ?? fertige[0]
  useEffect(() => {
    if (gewaehlt && gewaehlt.id !== auswahlId) setAuswahlId(gewaehlt.id)
    if (!gewaehlt && auswahlId) setAuswahlId(null)
  }, [gewaehlt, auswahlId])
  useEffect(() => {
    setGesichert(false)
  }, [gewaehlt?.id])

  return (
    <>
      <header className="header">
        <div className="container header-inner">
          <div className="header-brand">
            <img className="header-logo" src={logo} alt="ISOTEC" />
            <div className="header-divider" />
            <div>
              <h1>ISOTEC-Sanierungsvorschau</h1>
              <p className="header-kicker">Vorher-Nachher aus dem Kellerfoto</p>
            </div>
          </div>
        </div>
      </header>

      <main className="container">
        {einstellungenOffen && (
          <section className="card">
            <h2>Einstellungen (nur Verwaltung)</h2>
            <p className="section-hint">
              Diese Seite ist absichtlich nicht verlinkt und nur über <code>#einstellungen</code> in
              der Adresse erreichbar. Der Schlüssel wird mit dem Programm ausgeliefert: Wer die
              Seite öffnet, kann sofort arbeiten, ohne etwas einzurichten. Das Feld unten
              überschreibt ihn nur auf diesem Gerät, leer lassen und speichern nimmt wieder den
              mitgelieferten. Kosten: etwa 4 Cent je Foto.
            </p>
            <p className="section-hint">
              Gerade in Benutzung:{' '}
              <strong>
                {eigener
                  ? 'eigener Schlüssel dieses Geräts'
                  : MITGELIEFERTER_SCHLUESSEL
                    ? 'mitgelieferter Schlüssel'
                    : 'keiner – diese Fassung wurde ohne Schlüssel gebaut'}
              </strong>
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
                Für die Kollegen genügt die normale Adresse, der Schlüssel ist schon drin. Nur wenn
                ein einzelnes Gerät einen anderen Schlüssel bekommen soll:{' '}
                <button className="btn btn-rand btn-klein" onClick={kopiereVerteilLink}>
                  {linkKopiert ? '✓ Link kopiert' : 'Link mit Schlüssel kopieren'}
                </button>
              </p>
            )}
          </section>
        )}

        {!schluessel && !einstellungenOffen && (
          <section className="card hinweis-warn">
            Die Bildbearbeitung ist gerade nicht verfügbar, dieser Fassung fehlt der Zugang zu
            Google. Bitte bei Yann melden. Fotos lassen sich schon auswählen, bearbeitet wird
            aber nichts.
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

          <div className="skizze-zeile">
            {skizze ? (
              <>
                <img className="skizze-vorschau" src={skizze.urls[0]} alt="Skizze" />
                <div className="skizze-text">
                  <strong>
                    Skizze: {skizze.name}
                    {skizze.urls.length > 1 ? ` (${skizze.urls.length} Seiten)` : ''}
                  </strong>
                  <span>
                    Saniert werden nur die auf der Skizze umrandeten Wandflächen, alles andere
                    bleibt. Gilt für alle Fotos.
                  </span>
                </div>
                <div className="fenster-knoepfe">
                  <button className="btn btn-rand btn-klein" onClick={() => skizzeFeld.current?.click()}>
                    Ersetzen
                  </button>
                  <button className="btn btn-rand btn-klein" onClick={entferneSkizze}>
                    Entfernen
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="skizze-text">
                  <strong>Skizze mit Sanierungsbereichen (optional)</strong>
                  <span>
                    Ein Foto oder PDF, auf dem die zu sanierenden Wandflächen umrandet sind. Dann
                    wird nur dort saniert; Texte und Maße auf der Skizze werden nicht beachtet.
                  </span>
                </div>
                <button className="btn btn-rand btn-klein" onClick={() => skizzeFeld.current?.click()}>
                  Skizze auswählen
                </button>
              </>
            )}
          </div>
          <input
            ref={skizzeFeld}
            type="file"
            accept="image/*,.heic,.heif,.pdf,application/pdf"
            hidden
            onChange={(e) => {
              const datei = e.target.files?.[0]
              if (datei) void nimmSkizze(datei)
              e.target.value = ''
            }}
          />
        </section>

        {fotos.length > 0 && (
          <section className="card">
            <h2>
              <span className="step">2</span>Vorher-Nachher
            </h2>
            <p className="section-hint">
              Foto in der Übersicht antippen, rechts erscheint der Vergleich.
              {skizze && fotos.some((f) => f.status === 'fertig' && !f.mitSkizze) && (
                <>
                  {' '}
                  <button
                    className="btn btn-rand btn-klein"
                    onClick={() => {
                      for (const foto of fotos) {
                        if (foto.status === 'fertig' && !foto.mitSkizze) bearbeiteErneut(foto)
                      }
                    }}
                  >
                    Fotos ohne Skizze neu bearbeiten
                  </button>
                </>
              )}
            </p>
            <div className="uebersicht">
            <div className="galerie">
              {fotos.map((foto) => {
                const istGewaehlt = gewaehlt?.id === foto.id
                const klassen = ['kachel']
                if (foto.status === 'fertig') klassen.push('klickbar')
                if (istGewaehlt) klassen.push('gewaehlt')
                return (
                  <figure
                    key={foto.id}
                    className={klassen.join(' ')}
                    onClick={() => {
                      if (foto.status === 'fertig') setAuswahlId(foto.id)
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
                        {foto.mitSkizze && <span className="kachel-marke">Skizze</span>}
                        {foto.name}
                      </span>
                      {(foto.status === 'fertig' || foto.status === 'fehler') && (
                        <button
                          className="kachel-entfernen"
                          aria-label="Foto erneut bearbeiten"
                          title="Erneut bearbeiten"
                          onClick={(e) => {
                            e.stopPropagation()
                            bearbeiteErneut(foto)
                          }}
                        >
                          ↻
                        </button>
                      )}
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

            <div className="vergleich-fenster">
              {gewaehlt ? (
                <>
                  <div className="fenster-kopf">
                    <strong className="fenster-name" title={gewaehlt.name}>
                      {gewaehlt.name}
                    </strong>
                    <div className="fenster-knoepfe">
                      <button
                        className="btn btn-rand btn-klein"
                        onClick={() => {
                          ladeNachherHerunter(gewaehlt.nachherBlob, gewaehlt.name)
                          setGesichert(true)
                        }}
                      >
                        {gesichert ? '✓ Heruntergeladen' : 'Herunterladen'}
                      </button>
                      {teilenMoeglich() && (
                        <button
                          className="btn btn-rand btn-klein"
                          onClick={() => void teileNachherBild(gewaehlt.nachherBlob, gewaehlt.name)}
                        >
                          In Fotos sichern
                        </button>
                      )}
                      <button
                        className="btn btn-rand btn-klein"
                        onClick={() =>
                          setZeigeIndex(fertige.findIndex((f) => f.id === gewaehlt.id))
                        }
                      >
                        Vollbild
                      </button>
                    </div>
                  </div>
                  <Vergleich
                    vorherUrl={gewaehlt.vorherUrl}
                    nachherUrl={gewaehlt.nachherUrl}
                    zuruecksetzenBei={gewaehlt.id}
                  />
                  <p className="fenster-hinweis">
                    Regler ziehen: links mehr Nachher, rechts mehr Vorher
                  </p>
                </>
              ) : (
                <p className="fenster-leer">
                  Sobald ein Foto fertig bearbeitet ist, erscheint hier der Vergleich.
                </p>
              )}
            </div>
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
