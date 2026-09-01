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
 * Der Arbeitsauftrag an das Modell. Bewusst eng gefasst: Perspektive, Boden
 * und Gegenstaende bleiben, nur Waende und Decke werden saniert dargestellt.
 */
const PROMPT = [
  'Bearbeite dieses Foto eines Kellers.',
  'Zeige exakt denselben Raum nach einer professionellen Kellersanierung:',
  'Alle Wände und die Decke sind frisch verputzt mit glattem, hellem Sanierputz und deckend weiß gestrichen.',
  'Entferne sämtliche Feuchtigkeitsschäden, Schimmel, Stockflecken, Salzausblühungen, abblätternde Farbe, Risse, dunkle Flecken und Verschmutzungen an Wänden und Decke.',
  'Der Raum wirkt hell, trocken und sauber.',
  'Behalte exakt dieselbe Kameraperspektive und Raumgeometrie bei, ebenso Boden, Fenster, Türen, Treppen, Rohre, Leitungen, Zähler und alle Gegenstände im Raum.',
  'Das Ergebnis muss wie ein echtes, unbearbeitetes Foto desselben Raums aussehen.',
  'Kein Text, kein Wasserzeichen.',
].join(' ')

export class GeminiFehler extends Error {
  /** true, wenn ein weiterer Versuch ohne Aenderung sinnvoll sein kann. */
  wiederholbar: boolean
  constructor(nachricht: string, wiederholbar: boolean) {
    super(nachricht)
    this.wiederholbar = wiederholbar
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
      throw new GeminiFehler(
        'Der API-Schlüssel wurde nicht akzeptiert. Schlüssel unter Einstellungen prüfen.',
        false,
      )
    }
    if (antwort.status === 429) {
      throw new GeminiFehler(
        'Das Kontingent ist gerade ausgeschöpft (zu viele Anfragen). Kurz warten und erneut versuchen.',
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
