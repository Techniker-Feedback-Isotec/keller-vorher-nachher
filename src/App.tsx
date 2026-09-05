import { useEffect, useRef, useState } from 'react'
import logo from './assets/isotec-logo.png'
import Vergleich from './Vergleich'
import Viewer, { type ViewerFoto } from './Viewer'
import { ladeNachherHerunter, teileNachherBild, teilenMoeglich } from './lib/share'
import { bereiteBildVor, blobZuBase64 } from './lib/bild'
import { GeminiFehler, erfasseBestand, saniereFoto } from './lib/gemini'
import {
  MITGELIEFERTER_SCHLUESSEL,
  leseEigenenSchluessel,
  leseSchluessel,
  speichereSchluessel,
  uebernimmSchluesselAusLink,
  verteilLink,
} from './lib/schluessel'

/**
 * Je Foto gibt es zwei Erstellvarianten (Yann, 05.09.2026):
 * - standard: Waende und Decke saniert, Boden bleibt in seiner Substanz.
 * - boden:    zusaetzlich der Boden vollflaechig hellgrau beschichtet.
 * Beide Ergebnisse bleiben erhalten, man wechselt per Haekchen dazwischen.
 */
type Variante = 'standard' | 'boden'

type Ergebnis = {
  status: 'laeuft' | 'fertig' | 'fehler'
  url?: string
  blob?: Blob
  fehler?: string
}

type Foto = {
  id: string
  name: string
  vorherUrl: string
  vorherBlob: Blob
  /** Zustand des Vorher-Bilds: wird gelesen, wartet auf Schluessel, oder bereit. */
  status: 'liest' | 'wartet' | 'bereit' | 'lesefehler'
  fehler?: string
  ergebnisse: Partial<Record<Variante, Ergebnis>>
  /** Welche Variante gerade gezeigt wird. */
  variante: Variante
  /** Vom Textmodell erkannter Bestand; wird einmal je Foto ermittelt und fuer beide Varianten genutzt. */
  bestand?: string
}

const VARIANTEN_NAME: Record<Variante, string> = {
  standard: 'Standard',
  boden: 'Boden sanieren',
}

function aktuell(foto: Foto): Ergebnis | undefined {
  return foto.ergebnisse[foto.variante]
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
  const [eigener, setEigener] = useState('')
  const [linkKopiert, setLinkKopiert] = useState(false)
  const [auswahlId, setAuswahlId] = useState<string | null>(null)
  const [gesichert, setGesichert] = useState(false)
  const [zeigeIndex, setZeigeIndex] = useState<number | null>(null)
  const [ziehtDatei, setZiehtDatei] = useState(false)
  const dateiFeld = useRef<HTMLInputElement>(null)
  const schluesselRef = useRef('')
  schluesselRef.current = schluessel
  // Laufende Verarbeitungen brauchen den aktuellen Stand (z. B. den Bestand).
  const fotosRef = useRef<Foto[]>([])
  fotosRef.current = fotos

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
          const { vorher, nachher } = await demoBilder(nummer, false)
          const { nachher: nachherBoden } = await demoBilder(nummer, true)
          setFotos((liste) => [
            ...liste,
            {
              id: `demo-${naechsteId++}`,
              name,
              vorherUrl: URL.createObjectURL(vorher),
              vorherBlob: vorher,
              status: 'bereit',
              variante: 'standard',
              ergebnisse: {
                standard: { status: 'fertig', url: URL.createObjectURL(nachher), blob: nachher },
                boden: { status: 'fertig', url: URL.createObjectURL(nachherBoden), blob: nachherBoden },
              },
            },
          ])
        }
      })()
    }
  }, [])

  function aktualisiere(id: string, aenderung: Partial<Foto>) {
    setFotos((liste) => liste.map((f) => (f.id === id ? { ...f, ...aenderung } : f)))
  }

  function setzeErgebnis(id: string, variante: Variante, ergebnis: Ergebnis) {
    setFotos((liste) =>
      liste.map((f) => {
        if (f.id !== id) return f
        const alt = f.ergebnisse[variante]
        if (alt?.url && alt.url !== ergebnis.url) URL.revokeObjectURL(alt.url)
        return { ...f, ergebnisse: { ...f.ergebnisse, [variante]: ergebnis } }
      }),
    )
  }

  /**
   * Erzeugt eine Variante fuer ein Foto. Ein wiederholbarer Fehler bekommt
   * einen zweiten Versuch; der Bestand wird je Foto nur einmal ermittelt.
   */
  async function verarbeite(id: string, vorherBlob: Blob, variante: Variante) {
    if (!schluesselRef.current) {
      aktualisiere(id, { status: 'wartet' })
      return
    }
    setzeErgebnis(id, variante, { status: 'laeuft' })
    try {
      const base64 = await blobZuBase64(vorherBlob)
      const bodenHellgrau = variante === 'boden'
      const blob = await mitPlatz(async () => {
        // Erst schauen, was da ist: Die Liste geht als Pflichtbestand in den
        // Bildauftrag, damit Fenster und Rohre nicht verschwinden oder entstehen.
        let bestand = fotosRef.current.find((f) => f.id === id)?.bestand ?? ''
        if (!bestand) {
          bestand = await erfasseBestand(base64, schluesselRef.current)
          if (bestand) aktualisiere(id, { bestand })
        }
        const optionen = { bestand: bestand || undefined, bodenHellgrau }
        try {
          return await saniereFoto(base64, schluesselRef.current, optionen)
        } catch (fehler) {
          if (fehler instanceof GeminiFehler && fehler.wiederholbar) {
            await new Promise((r) => setTimeout(r, 4000))
            return await saniereFoto(base64, schluesselRef.current, optionen)
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
            return await saniereFoto(base64, MITGELIEFERTER_SCHLUESSEL, optionen)
          }
          throw fehler
        }
      })
      setzeErgebnis(id, variante, { status: 'fertig', blob, url: URL.createObjectURL(blob) })
    } catch (fehler) {
      setzeErgebnis(id, variante, {
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
        {
          id,
          name,
          vorherUrl: '',
          vorherBlob: datei,
          status: 'liest',
          variante: 'standard',
          ergebnisse: {},
        },
      ])
      try {
        const { blob } = await bereiteBildVor(datei)
        aktualisiere(id, { vorherBlob: blob, vorherUrl: URL.createObjectURL(blob), status: 'bereit' })
        void verarbeite(id, blob, 'standard')
      } catch {
        aktualisiere(id, { status: 'lesefehler', fehler: 'Foto konnte nicht gelesen werden.' })
      }
    }
  }

  /** Haekchen "Boden sanieren": Variante wechseln und bei Bedarf erst erzeugen. */
  function waehleVariante(foto: Foto, variante: Variante) {
    aktualisiere(foto.id, { variante })
    if (!foto.ergebnisse[variante]) void verarbeite(foto.id, foto.vorherBlob, variante)
  }

  /** Die gerade gezeigte Variante noch einmal erzeugen. */
  function bearbeiteErneut(foto: Foto) {
    void verarbeite(foto.id, foto.vorherBlob, foto.variante)
  }

  function entferne(id: string) {
    setFotos((liste) => {
      const foto = liste.find((f) => f.id === id)
      if (foto?.vorherUrl) URL.revokeObjectURL(foto.vorherUrl)
      for (const e of Object.values(foto?.ergebnisse ?? {})) if (e?.url) URL.revokeObjectURL(e.url)
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
        if (foto.status === 'wartet') {
          aktualisiere(foto.id, { status: 'bereit' })
          void verarbeite(foto.id, foto.vorherBlob, foto.variante)
        }
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

  // Im Fenster gezeigt wird das gewaehlte Foto, sonst das erste mit fertigem
  // Ergebnis, sonst das erste bereite. Die Vollbildansicht kennt nur fertige.
  const anzeigbar = fotos.filter((f) => f.status === 'bereit')
  const gewaehlt =
    anzeigbar.find((f) => f.id === auswahlId) ??
    anzeigbar.find((f) => aktuell(f)?.status === 'fertig') ??
    anzeigbar[0]
  const gewaehltesErgebnis = gewaehlt ? aktuell(gewaehlt) : undefined

  const fertige: ViewerFoto[] = anzeigbar
    .filter((f) => aktuell(f)?.status === 'fertig')
    .map((f) => {
      const e = aktuell(f)!
      return {
        id: f.id,
        name: f.variante === 'boden' ? `${f.name} (Boden saniert)` : f.name,
        vorherUrl: f.vorherUrl,
        nachherUrl: e.url!,
        nachherBlob: e.blob!,
      }
    })

  useEffect(() => {
    if (gewaehlt && gewaehlt.id !== auswahlId) setAuswahlId(gewaehlt.id)
    if (!gewaehlt && auswahlId) setAuswahlId(null)
  }, [gewaehlt, auswahlId])
  useEffect(() => {
    setGesichert(false)
  }, [gewaehlt?.id, gewaehlt?.variante])

  function dateiname(foto: Foto): string {
    return foto.variante === 'boden' ? `${foto.name} Boden saniert` : foto.name
  }

  return (
    <>
      <header className="header">
        <div className="container header-inner">
          <div className="header-brand">
            <img className="header-logo" src={logo} alt="ISOTEC" />
            <div className="header-divider" />
            <h1>ISOTEC-Sanierungsvorschau</h1>
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
              mitgelieferten. Bildmodell ist das Pro-Modell von Gemini; die Kosten je Foto
              liegen etwa beim Dreifachen des Flash-Modells, der Verbrauch ist in AI Studio
              einsehbar.
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
              <span className="step">2</span>Vorher-Nachher
            </h2>
            <div className="uebersicht">
              <div className="galerie">
                {fotos.map((foto) => {
                  const ergebnis = aktuell(foto)
                  const istGewaehlt = gewaehlt?.id === foto.id
                  const klassen = ['kachel']
                  if (foto.status === 'bereit') klassen.push('klickbar')
                  if (istGewaehlt) klassen.push('gewaehlt')
                  return (
                    <figure
                      key={foto.id}
                      className={klassen.join(' ')}
                      onClick={() => {
                        if (foto.status === 'bereit') setAuswahlId(foto.id)
                      }}
                    >
                      <div className="kachel-bild">
                        {foto.vorherUrl && <img src={foto.vorherUrl} alt={`${foto.name} vorher`} />}
                        {ergebnis?.status === 'fertig' && ergebnis.url && (
                          <>
                            <img
                              src={ergebnis.url}
                              alt={`${foto.name} nachher`}
                              style={{ clipPath: 'inset(0 0 0 50%)' }}
                            />
                            <span className="kachel-teiler" />
                          </>
                        )}
                        {(foto.status === 'liest' || ergebnis?.status === 'laeuft') && (
                          <span className="kachel-schleier">
                            <span className="dreher" />
                            {foto.status === 'liest'
                              ? 'Wird gelesen …'
                              : foto.variante === 'boden'
                                ? 'Boden wird saniert …'
                                : 'Wird saniert …'}
                          </span>
                        )}
                        {foto.status === 'wartet' && (
                          <span className="kachel-schleier">Wartet auf Schlüssel</span>
                        )}
                        {(foto.status === 'lesefehler' || ergebnis?.status === 'fehler') && (
                          <span className="kachel-schleier kachel-fehler">
                            {foto.status === 'lesefehler' ? foto.fehler : ergebnis?.fehler}
                            {foto.status !== 'lesefehler' && (
                              <button
                                className="btn btn-hell btn-klein"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  bearbeiteErneut(foto)
                                }}
                              >
                                Erneut versuchen
                              </button>
                            )}
                          </span>
                        )}
                      </div>
                      <figcaption>
                        <div className="kachel-zeile">
                          <span className="kachel-name" title={foto.name}>
                            {foto.name}
                          </span>
                          {(ergebnis?.status === 'fertig' || ergebnis?.status === 'fehler') && (
                            <button
                              className="kachel-entfernen"
                              aria-label="Diese Variante erneut bearbeiten"
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
                        </div>
                        {foto.status === 'bereit' && (
                          <label className="kachel-option" onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={foto.variante === 'boden'}
                              onChange={(e) =>
                                waehleVariante(foto, e.target.checked ? 'boden' : 'standard')
                              }
                            />
                            Boden sanieren
                          </label>
                        )}
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
                        <span className="kachel-marke">{VARIANTEN_NAME[gewaehlt.variante]}</span>
                      </strong>
                      <div className="fenster-knoepfe">
                        <label className="kachel-option fenster-option">
                          <input
                            type="checkbox"
                            checked={gewaehlt.variante === 'boden'}
                            onChange={(e) =>
                              waehleVariante(gewaehlt, e.target.checked ? 'boden' : 'standard')
                            }
                          />
                          Boden sanieren
                        </label>
                        {gewaehltesErgebnis?.status === 'fertig' && gewaehltesErgebnis.blob && (
                          <>
                            <button
                              className="btn btn-rand btn-klein"
                              onClick={() => {
                                ladeNachherHerunter(gewaehltesErgebnis.blob!, dateiname(gewaehlt))
                                setGesichert(true)
                              }}
                            >
                              {gesichert ? '✓ Heruntergeladen' : 'Herunterladen'}
                            </button>
                            {teilenMoeglich() && (
                              <button
                                className="btn btn-rand btn-klein"
                                onClick={() =>
                                  void teileNachherBild(gewaehltesErgebnis.blob!, dateiname(gewaehlt))
                                }
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
                          </>
                        )}
                      </div>
                    </div>

                    {gewaehltesErgebnis?.status === 'fertig' && gewaehltesErgebnis.url ? (
                      <Vergleich
                        vorherUrl={gewaehlt.vorherUrl}
                        nachherUrl={gewaehltesErgebnis.url}
                        zuruecksetzenBei={`${gewaehlt.id}-${gewaehlt.variante}`}
                      />
                    ) : gewaehltesErgebnis?.status === 'fehler' ? (
                      <p className="fenster-leer">
                        {gewaehltesErgebnis.fehler}
                        <br />
                        <button className="btn btn-rand btn-klein" onClick={() => bearbeiteErneut(gewaehlt)}>
                          Erneut versuchen
                        </button>
                      </p>
                    ) : (
                      <p className="fenster-leer">
                        <span className="dreher dreher-dunkel" />
                        {gewaehlt.variante === 'boden' ? 'Boden wird saniert …' : 'Wird saniert …'}
                      </p>
                    )}

                    {/* Diagnose nur fuer die Verwaltung (#einstellungen), nicht im Einsatz. */}
                    {einstellungenOffen && gewaehlt.bestand && (
                      <details className="bestand">
                        <summary>Erkannter Bestand</summary>
                        <pre>{gewaehlt.bestand}</pre>
                      </details>
                    )}
                  </>
                ) : (
                  <p className="fenster-leer">Noch kein Foto ausgewählt.</p>
                )}
              </div>
            </div>

          </section>
        )}
      </main>

      <footer className="fusszeile">
        Abdichtungstechnik Dipl.-Ing. Morscheck GmbH · KI-Visualisierung, kein zugesichertes
        Sanierungsergebnis
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
