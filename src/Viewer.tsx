import { useCallback, useEffect, useRef, useState } from 'react'
import { speichereDatei, teileDateien, teilenMoeglich } from './lib/share'

export type ViewerFoto = {
  id: string
  name: string
  vorherUrl: string
  nachherUrl: string
  nachherBlob: Blob
}

type Props = {
  fotos: ViewerFoto[]
  index: number
  onIndex: (index: number) => void
  onClose: () => void
}

/**
 * Grossansicht mit Schieberegler: links das alte Foto (Vorher), rechts das
 * sanierte (Nachher). Zieht man den Griff nach links, sieht man mehr vom
 * Nachher-Bild, nach rechts mehr vom Vorher-Bild.
 */
export default function Viewer({ fotos, index, onIndex, onClose }: Props) {
  const foto = fotos[index]
  const [position, setPosition] = useState(50)
  const [gesichert, setGesichert] = useState(false)
  const flaeche = useRef<HTMLDivElement>(null)
  const zieht = useRef(false)

  // Beim Fotowechsel zurueck in die Mitte.
  useEffect(() => {
    setPosition(50)
    setGesichert(false)
  }, [foto?.id])

  const setzeAusEreignis = useCallback((clientX: number) => {
    const rect = flaeche.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return
    const anteil = ((clientX - rect.left) / rect.width) * 100
    setPosition(Math.max(0, Math.min(100, anteil)))
  }, [])

  useEffect(() => {
    const taste = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1)
      if (e.key === 'ArrowRight' && index < fotos.length - 1) onIndex(index + 1)
    }
    window.addEventListener('keydown', taste)
    return () => window.removeEventListener('keydown', taste)
  }, [index, fotos.length, onClose, onIndex])

  if (!foto) return null

  async function sichern() {
    const endung = foto.nachherBlob.type.includes('png') ? 'png' : 'jpg'
    const dateiname = `ISOTEC_Nachher_${foto.name.replace(/[^\wäöüÄÖÜß. -]+/g, '')}.${endung}`
    const file = new File([foto.nachherBlob], dateiname, { type: foto.nachherBlob.type })
    if (teilenMoeglich()) {
      const ergebnis = await teileDateien([file], 'Nachher-Bild')
      if (ergebnis === 'geteilt') setGesichert(true)
      if (ergebnis !== 'nicht moeglich') return
    }
    speichereDatei(foto.nachherBlob, dateiname)
    setGesichert(true)
  }

  return (
    <div className="viewer" role="dialog" aria-label="Vorher-Nachher-Vergleich">
      <div className="viewer-kopf">
        <div className="viewer-titel">
          <strong>{foto.name}</strong>
          <span>
            {index + 1} von {fotos.length}
          </span>
        </div>
        <div className="viewer-knoepfe">
          <button className="btn btn-hell" onClick={sichern}>
            {gesichert ? '✓ Gesichert' : teilenMoeglich() ? 'In Fotos sichern' : 'Nachher speichern'}
          </button>
          <button className="btn btn-hell viewer-zu" onClick={onClose} aria-label="Schließen">
            ✕
          </button>
        </div>
      </div>

      <div className="viewer-mitte">
        {index > 0 && (
          <button className="viewer-pfeil links" onClick={() => onIndex(index - 1)} aria-label="Vorheriges Foto">
            ‹
          </button>
        )}

        <div
          ref={flaeche}
          className="vergleich"
          onPointerDown={(e) => {
            zieht.current = true
            ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
            setzeAusEreignis(e.clientX)
          }}
          onPointerMove={(e) => {
            if (zieht.current) setzeAusEreignis(e.clientX)
          }}
          onPointerUp={() => {
            zieht.current = false
          }}
          onPointerCancel={() => {
            zieht.current = false
          }}
        >
          <img className="vergleich-bild" src={foto.vorherUrl} alt="Vorher" draggable={false} />
          <img
            className="vergleich-bild vergleich-nachher"
            src={foto.nachherUrl}
            alt="Nachher"
            draggable={false}
            style={{ clipPath: `inset(0 0 0 ${position}%)` }}
          />
          <span className="vergleich-marke links-oben">Vorher</span>
          <span className="vergleich-marke rechts-oben">Nachher</span>
          <div className="vergleich-linie" style={{ left: `${position}%` }}>
            <div className="vergleich-griff">⇄</div>
          </div>
        </div>

        {index < fotos.length - 1 && (
          <button className="viewer-pfeil rechts" onClick={() => onIndex(index + 1)} aria-label="Nächstes Foto">
            ›
          </button>
        )}
      </div>

      <p className="viewer-hinweis">Regler ziehen: links mehr Nachher, rechts mehr Vorher</p>
    </div>
  )
}
