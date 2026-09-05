/**
 * PDF "ISOTEC Sanierungsvorschau" (Yann, 05.09.2026).
 *
 * Titelseite im ISOTEC-Design, danach je Foto eine Seite mit Vorher links und
 * Nachher rechts, genau in der Variante, die gerade ausgewaehlt ist. A4 quer,
 * weil zwei Bilder nebeneinander so am groessten werden. Farben aus dem
 * Corporate-Design-Handbuch, Schrift Helvetica (im Handbuch FF Dax, die liegt
 * hier nicht vor). pdf-lib laeuft komplett im Browser, wie in der Fotodoku.
 */
import { PDFDocument, PDFFont, PDFImage, PDFPage, StandardFonts, rgb } from 'pdf-lib'

const RED = rgb(213 / 255, 19 / 255, 23 / 255) // #D51317
const BROWN = rgb(86 / 255, 74 / 255, 68 / 255) // #564A44
const GREY = rgb(224 / 255, 224 / 255, 224 / 255) // #E0E0E0
const LIGHT = rgb(244 / 255, 244 / 255, 244 / 255) // #F4F4F4
const MUTED = rgb(138 / 255, 127 / 255, 120 / 255)
const WHITE = rgb(1, 1, 1)

// A4 quer in Punkt
const W = 841.89
const H = 595.28
const RAND = 40

const FIRMA = 'Abdichtungstechnik Dipl.-Ing. Morscheck GmbH'
const HINWEIS = 'KI-Visualisierung, kein zugesichertes Sanierungsergebnis'

export type PdfEintrag = {
  name: string
  /** Bezeichnung der gewaehlten Variante, 'Standard' wird nicht gedruckt. */
  variante: string
  vorher: Blob
  nachher: Blob
}

/** Bild als JPEG mit begrenzter Kante, damit die PDF handlich bleibt (Nachher kommt oft als PNG). */
async function zuJpeg(blob: Blob, maxKante = 1600): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(blob)
  const faktor = Math.min(1, maxKante / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * faktor)
  canvas.height = Math.round(bitmap.height * faktor)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas nicht verfügbar')
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const jpeg = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Bild konnte nicht umgewandelt werden'))), 'image/jpeg', 0.85)
  })
  return new Uint8Array(await jpeg.arrayBuffer())
}

function eingepasst(bild: PDFImage, maxB: number, maxH: number): { w: number; h: number } {
  const s = Math.min(maxB / bild.width, maxH / bild.height)
  return { w: bild.width * s, h: bild.height * s }
}

function gekuerzt(font: PDFFont, text: string, groesse: number, maxB: number): string {
  if (font.widthOfTextAtSize(text, groesse) <= maxB) return text
  let t = text
  while (t.length > 1 && font.widthOfTextAtSize(`${t}…`, groesse) > maxB) t = t.slice(0, -1)
  return `${t.trimEnd()}…`
}

/** Farbige Marke mit weisser Schrift, wie die Vorher/Nachher-Marken in der App. */
function marke(page: PDFPage, font: PDFFont, text: string, x: number, y: number, farbe = BROWN) {
  const groesse = 10
  const b = font.widthOfTextAtSize(text, groesse)
  page.drawRectangle({ x, y, width: b + 14, height: 18, color: farbe })
  page.drawText(text, { x: x + 7, y: y + 5, size: groesse, font, color: WHITE })
}

function fusszeile(page: PDFPage, regular: PDFFont, links: string, rechts: string) {
  page.drawRectangle({ x: 0, y: 0, width: W, height: 6, color: RED })
  page.drawText(links, { x: RAND, y: 18, size: 8.5, font: regular, color: MUTED })
  const b = regular.widthOfTextAtSize(rechts, 8.5)
  page.drawText(rechts, { x: W - RAND - b, y: 18, size: 8.5, font: regular, color: MUTED })
}

export async function erzeugeSanierungsvorschauPdf(
  eintraege: PdfEintrag[],
  logoPng: Uint8Array,
): Promise<Blob> {
  if (eintraege.length === 0) throw new Error('Keine fertigen Bilder für die PDF')

  const doc = await PDFDocument.create()
  doc.setTitle('ISOTEC Sanierungsvorschau')
  doc.setAuthor(FIRMA)
  doc.setCreator('ISOTEC-Sanierungsvorschau')
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const regular = await doc.embedFont(StandardFonts.Helvetica)
  const logo = await doc.embedPng(logoPng)
  const gesamt = eintraege.length + 1
  const datum = new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })

  // ---- Titelseite ----
  {
    const page = doc.addPage([W, H])
    page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: WHITE })

    // Logo oben links
    const logoH = 34
    const logoW = (logo.width / logo.height) * logoH
    page.drawImage(logo, { x: RAND, y: H - RAND - logoH, width: logoW, height: logoH })

    // Rechte Haelfte: das erste Nachher-Bild als Blickfang, auf hellem Feld
    const feldX = W / 2
    const feldY = 90
    const feldB = W / 2 - RAND
    const feldH = H - feldY - RAND - logoH - 20
    page.drawRectangle({ x: feldX, y: feldY, width: feldB, height: feldH, color: LIGHT })
    const hero = await doc.embedJpg(await zuJpeg(eintraege[0].nachher, 1400))
    const hg = eingepasst(hero, feldB - 30, feldH - 30)
    const hx = feldX + (feldB - hg.w) / 2
    const hy = feldY + (feldH - hg.h) / 2
    page.drawImage(hero, { x: hx, y: hy, width: hg.w, height: hg.h })
    marke(page, bold, 'Nachher', hx + 10, hy + hg.h - 28, RED)

    // Linke Haelfte: Titel
    const textX = RAND
    let y = H / 2 + 70
    page.drawText('Sanierungsvorschau', { x: textX, y, size: 38, font: bold, color: BROWN })
    y -= 18
    page.drawRectangle({ x: textX, y, width: 70, height: 5, color: RED })
    y -= 34
    page.drawText('Ihr Keller vorher und nachher', { x: textX, y, size: 16, font: regular, color: MUTED })
    y -= 40
    page.drawText(`Erstellt am ${datum}`, { x: textX, y, size: 12, font: regular, color: BROWN })
    y -= 20
    page.drawText(
      `${eintraege.length} ${eintraege.length === 1 ? 'Foto' : 'Fotos'} im Vergleich`,
      { x: textX, y, size: 12, font: regular, color: BROWN },
    )
    y -= 20
    page.drawText(FIRMA, { x: textX, y, size: 12, font: regular, color: BROWN })

    fusszeile(page, regular, `${FIRMA} · ${HINWEIS}`, `Seite 1 von ${gesamt}`)
  }

  // ---- Je Foto eine Seite: Vorher links, Nachher rechts ----
  for (const [i, e] of eintraege.entries()) {
    const page = doc.addPage([W, H])
    page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: WHITE })

    // Kopf
    const kopfY = H - 52
    const rechts = `Foto ${i + 1} von ${eintraege.length}`
    const rechtsB = regular.widthOfTextAtSize(rechts, 10)
    page.drawText(rechts, { x: W - RAND - rechtsB, y: kopfY, size: 10, font: regular, color: MUTED })
    const titel = gekuerzt(bold, e.name, 16, W - 2 * RAND - rechtsB - 20)
    page.drawText(titel, { x: RAND, y: kopfY, size: 16, font: bold, color: BROWN })
    if (e.variante && e.variante !== 'Standard') {
      page.drawText(e.variante, { x: RAND, y: kopfY - 16, size: 10, font: regular, color: MUTED })
    }
    page.drawLine({ start: { x: RAND, y: H - 80 }, end: { x: W - RAND, y: H - 80 }, thickness: 0.8, color: GREY })

    // Zwei Bildfelder
    const oben = H - 96
    const unten = 44
    const spalt = 20
    const feldB = (W - 2 * RAND - spalt) / 2
    const feldH = oben - unten
    const vorher = await doc.embedJpg(await zuJpeg(e.vorher))
    const nachher = await doc.embedJpg(await zuJpeg(e.nachher))
    const paare: Array<[PDFImage, number, string, ReturnType<typeof rgb>]> = [
      [vorher, RAND, 'Vorher', BROWN],
      [nachher, RAND + feldB + spalt, 'Nachher', RED],
    ]
    for (const [bild, x0, text, farbe] of paare) {
      const g = eingepasst(bild, feldB, feldH)
      const x = x0 + (feldB - g.w) / 2
      const y = oben - g.h
      page.drawImage(bild, { x, y, width: g.w, height: g.h })
      marke(page, bold, text, x + 10, y + g.h - 28, farbe)
    }

    fusszeile(page, regular, `ISOTEC Sanierungsvorschau · ${FIRMA}`, `Seite ${i + 2} von ${gesamt}`)
  }

  const bytes = await doc.save()
  // Kopie in einen eigenen ArrayBuffer: pdf-lib liefert Uint8Array<ArrayBufferLike>,
  // Blob verlangt ArrayBuffer.
  return new Blob([Uint8Array.from(bytes)], { type: 'application/pdf' })
}
