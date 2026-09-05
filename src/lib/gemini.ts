/**
 * Anbindung an Google Gemini (Modell gemini-2.5-flash-image).
 *
 * Der Aufruf geht direkt aus dem Browser an die Google-API, es gibt keinen
 * eigenen Server. Der API-Schluessel wird einmal je Geraet hinterlegt und
 * liegt im localStorage (siehe schluessel.ts).
 */

const MODELL = 'gemini-2.5-flash-image'
const URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODELL}:generateContent`

/**
 * Der Arbeitsauftrag an das Modell. Grundlage ist Yanns Beispielpaar vom
 * 01.09.2026 (Waschkueche), am 04./05.09.2026 nach seinen Tests geschaerft:
 * Waende werden glatte weisse Flaechen ohne Steinmuster, Verkleidungen wie
 * Rigips oder Holzvertaefelung verschwinden (das gefaellt ihm). Der Boden
 * wird in seiner Substanz NIE veraendert, nur heller und sauberer (der
 * fruehere 30-cm-Streifen ist gestrichen). Rohre, Leitungen und Heizkoerper
 * bleiben ALLE erhalten, hoechstens gepflegter, weil das Modell am 05.09. ein
 * Rohr entfernt hatte. Absaetze und Ueberschriften helfen dem Modell, die
 * Regeln je Bauteil auseinanderzuhalten.
 */
const PROMPT = [
  'Bearbeite dieses Foto eines Kellers.',
  'Zeige exakt denselben Raum nach einer professionellen Kellersanierung. Halte dich genau an diese Regeln:',
  '',
  'WÄNDE:',
  'Jede Wandfläche wird zu einer vollkommen ebenen, glatten, deckend weiß gestrichenen Fläche.',
  'Es darf kein Mauerwerk, kein Stein-, Ziegel- oder Fugenmuster und keine Struktur mehr zu erkennen sein, die Wand ist frisch verputzt und weiß.',
  'Sind Wände mit Rigips, Gipskartonplatten, Holzvertäfelung, Paneelen, Regalen an der Wand oder ähnlichen Verkleidungen bedeckt: Entferne diese Verkleidungen vollständig und zeige auch dort eine glatte, weiß gestrichene Wand.',
  'Sämtliche Feuchtigkeitsschäden, Schimmel, Stockflecken, Salzausblühungen, abblätternde Farbe, Risse und dunkle Flecken sind verschwunden.',
  '',
  'DECKE:',
  'Die Decke ist glatt verputzt und weiß gestrichen, ohne Flecken und Schäden.',
  '',
  'BODEN:',
  'Verändere den Boden niemals in seiner Bausubstanz. Fliesen, Fugen, Estrich, Beton, Platten, Muster, Farbe und Aufteilung bleiben exakt so, wie sie auf dem Foto sind. Nichts wird entfernt, ersetzt oder hinzugefügt.',
  'Erlaubt ist nur: Der Boden wirkt sauberer, trockener und durch bessere Beleuchtung etwas heller. Schmutz, Staub, Pfützen und Flecken sind weg. Er muss sofort als derselbe Boden erkennbar sein.',
  '',
  'LEITUNGEN, ROHRE UND TECHNIK:',
  'Alle vorhandenen Rohre, Wasserleitungen, Heizungsrohre, Kabel, Kabelkanäle, Lüftungsrohre, Heizkörper, Zähler, Verteilerkästen, Ventile und Anschlüsse bleiben vollständig erhalten, an derselben Stelle, in derselben Form und Führung.',
  'Nichts davon darf entfernt, verkürzt, verlegt oder durch etwas anderes ersetzt werden. Erlaubt ist nur, dass sie gepflegt aussehen, etwa frisch gestrichen oder sauber, ohne Rost und Staub.',
  '',
  'GEGENSTÄNDE:',
  'Lose herumstehende Gegenstände wie Eimer, Flaschen, Kartons, Holzreste und Gerümpel sind weggeräumt.',
  'Fest installierte Dinge bleiben unverändert erhalten: Geräte wie Waschmaschinen, Trockner, Heizungen und Boiler samt Schläuchen, Wasseranschlüsse und Armaturen, Türen, Fenster, Treppen, Bodenabläufe, Lichtschalter, Steckdosen und Lampen.',
  '',
  'ALLGEMEIN:',
  'Behalte exakt dieselbe Kameraperspektive und Raumgeometrie bei.',
  'Der Raum wirkt hell, trocken und sauber, mit neutraler heller Ausleuchtung.',
  'Das Ergebnis muss wie ein echtes, unbearbeitetes Foto desselben Raums aussehen.',
  'Kein Text, kein Wasserzeichen.',
].join('\n')

export class GeminiFehler extends Error {
  /** true, wenn ein weiterer Versuch ohne Aenderung sinnvoll sein kann. */
  wiederholbar: boolean
  /** true, wenn Google den Schluessel selbst abgelehnt hat (ungueltig, gesperrt, falsche Herkunft). */
  schluesselAbgelehnt: boolean
  constructor(nachricht: string, wiederholbar: boolean, schluesselAbgelehnt = false) {
    super(nachricht)
    this.wiederholbar = wiederholbar
    this.schluesselAbgelehnt = schluesselAbgelehnt
  }
}

type ApiAntwort = {
  candidates?: Array<{
    content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> }
    finishReason?: string
  }>
  error?: { code?: number; message?: string; status?: string }
}

/** Schickt das Vorher-Bild (JPEG, Base64) an Gemini und liefert das Nachher-Bild. */
export async function saniereFoto(base64Jpeg: string, schluessel: string): Promise<Blob> {
  let antwort: Response
  try {
    antwort = await fetch(URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': schluessel,
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { inlineData: { mimeType: 'image/jpeg', data: base64Jpeg } },
              { text: PROMPT },
            ],
          },
        ],
      }),
    })
  } catch {
    throw new GeminiFehler('Keine Verbindung zu Google. Internetverbindung prüfen.', true)
  }

  if (!antwort.ok) {
    let detail = ''
    try {
      const json = (await antwort.json()) as ApiAntwort
      detail = json.error?.message ?? ''
    } catch {
      /* Rumpf war kein JSON */
    }
    if (antwort.status === 400 || antwort.status === 401 || antwort.status === 403) {
      // Googles Text mitgeben: "reported as leaked" heisst gesperrt, "not valid"
      // heisst geloescht oder falsch, "referer" heisst falsche Herkunft.
      throw new GeminiFehler(
        `Google hat den Zugangsschlüssel abgelehnt. Bitte bei Yann melden. ${detail}`.trim(),
        false,
        true,
      )
    }
    if (antwort.status === 429) {
      // Zwei sehr unterschiedliche Faelle kommen beide als 429:
      // 1. Kein Prepaid-Guthaben im Projekt. Dann ist jedes Kontingent 0 und
      //    Warten hilft nie – Guthaben muss in AI Studio aufgeladen werden.
      // 2. Echte Drosselung, weil gerade zu viele Anfragen laufen.
      const ohneGuthaben =
        /prepayment credits|free_tier_requests, limit: 0|billing details/i.test(detail)
      if (ohneGuthaben) {
        throw new GeminiFehler(
          'Für dieses Google-Projekt ist kein Guthaben vorhanden. Unter aistudio.google.com/billing Guthaben aufladen ("Buy credits", ab 10 $), danach erneut versuchen.',
          false,
        )
      }
      throw new GeminiFehler(
        `Das Kontingent ist gerade ausgeschöpft. Kurz warten und erneut versuchen. ${detail}`.trim(),
        true,
      )
    }
    throw new GeminiFehler(
      `Google meldet einen Fehler (${antwort.status}). ${detail}`.trim(),
      antwort.status >= 500,
    )
  }

  const json = (await antwort.json()) as ApiAntwort
  const parts = json.candidates?.[0]?.content?.parts ?? []
  const bild = parts.find((p) => p.inlineData?.data)
  if (!bild?.inlineData?.data) {
    throw new GeminiFehler('Das Modell hat kein Bild geliefert. Erneut versuchen.', true)
  }

  const roh = atob(bild.inlineData.data)
  const bytes = new Uint8Array(roh.length)
  for (let i = 0; i < roh.length; i++) bytes[i] = roh.charCodeAt(i)
  return new Blob([bytes], { type: bild.inlineData.mimeType ?? 'image/png' })
}
