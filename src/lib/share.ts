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
