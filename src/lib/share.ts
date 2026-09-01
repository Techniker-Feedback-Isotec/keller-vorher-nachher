/**
 * Teilen über das Betriebssystem (Web Share API).
 *
 * Auf dem iPhone ist das der einzige Weg, eine erzeugte Datei dorthin zu
 * bringen, wo sie hingehört: Ein Download landet in "Dateien / Downloads",
 * während das Teilen-Blatt "Bild sichern" (also die Fotomediathek) und alle
 * installierten Apps anbietet. Übernommen aus dem Fotodoku-Tool, dort im
 * Einsatz erprobt.
 */

export function teilenMoeglich(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function'
}

export type TeilenErgebnis = 'geteilt' | 'abgebrochen' | 'nicht moeglich'

export async function teileDateien(files: File[], titel: string): Promise<TeilenErgebnis> {
  if (!teilenMoeglich()) return 'nicht moeglich'
  try {
    if (typeof navigator.canShare === 'function' && !navigator.canShare({ files })) return 'nicht moeglich'
    await navigator.share({ files, title: titel })
    return 'geteilt'
  } catch (error) {
    // Abbruch durch den Nutzer ist kein Fehler.
    if (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'CanceledError')) {
      return 'abgebrochen'
    }
    return 'nicht moeglich'
  }
}

/**
 * Nachher-Bild ablegen: auf dem Handy über das Teilen-Blatt in die Fotos,
 * am Rechner als Download. Liefert true, wenn die Datei abgelegt wurde.
 */
export async function sichereNachherBild(blob: Blob, basisname: string): Promise<boolean> {
  const endung = blob.type.includes('png') ? 'png' : 'jpg'
  const sauber = basisname.replace(/[^\wäöüÄÖÜß. -]+/g, '').trim() || 'Foto'
  const dateiname = `ISOTEC_Nachher_${sauber}.${endung}`
  if (teilenMoeglich()) {
    const file = new File([blob], dateiname, { type: blob.type })
    const ergebnis = await teileDateien([file], 'Nachher-Bild')
    if (ergebnis === 'geteilt') return true
    // Abbruch durch den Nutzer: nichts tun, kein Download hinterherschieben.
    if (ergebnis === 'abgebrochen') return false
  }
  speichereDatei(blob, dateiname)
  return true
}

/** Herunterladen als Rückfallweg, wenn Teilen nicht geht (Desktop). */
export function speichereDatei(blob: Blob, dateiname: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = dateiname
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 20_000)
}
