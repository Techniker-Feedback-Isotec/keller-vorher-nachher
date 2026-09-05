/**
 * Skizze mit den umrandeten Sanierungsbereichen einlesen.
 *
 * Yann bringt die Skizze als Foto oder als PDF mit (mehrere Seiten sind
 * moeglich, eine je Wandansicht). Das Bildmodell nimmt nur Bilder an, deshalb
 * wird jede PDF-Seite hier im Browser zu einem JPEG gerendert. pdf.js wird
 * erst bei Bedarf geladen, es ist gross und die meisten Sitzungen brauchen es
 * nicht.
 */
import { bereiteBildVor } from './bild'

/** Mehr Seiten gehen als weitere Bilder mit an das Modell; acht sind mehr als genug. */
const MAX_SEITEN = 8
const MAX_KANTE = 1568

async function renderePdf(file: File): Promise<Blob[]> {
  const pdfjs = await import('pdfjs-dist')
  const { default: workerUrl } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

  const dokument = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise
  const seiten: Blob[] = []
  for (let nummer = 1; nummer <= Math.min(dokument.numPages, MAX_SEITEN); nummer++) {
    const seite = await dokument.getPage(nummer)
    const roh = seite.getViewport({ scale: 1 })
    const viewport = seite.getViewport({ scale: MAX_KANTE / Math.max(roh.width, roh.height) })

    const canvas = document.createElement('canvas')
    canvas.width = Math.round(viewport.width)
    canvas.height = Math.round(viewport.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas nicht verfügbar')
    // PDF-Seiten koennen transparent sein; die Skizze braucht weissen Grund.
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    await seite.render({ canvas, canvasContext: ctx, viewport }).promise

    seiten.push(
      await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error(`Seite ${nummer} konnte nicht umgewandelt werden`))),
          'image/jpeg',
          0.9,
        )
      }),
    )
  }
  if (seiten.length === 0) throw new Error('Das PDF enthält keine Seiten')
  return seiten
}

/** Liefert die Skizze als ein oder mehrere JPEG-Bilder (eine je PDF-Seite). */
export async function ladeSkizze(file: File): Promise<Blob[]> {
  const istPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
  if (istPdf) return renderePdf(file)
  return [(await bereiteBildVor(file)).blob]
}
