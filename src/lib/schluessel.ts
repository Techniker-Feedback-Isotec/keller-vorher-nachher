/**
 * Ablage des Gemini-API-Schluessels.
 *
 * Der Schluessel liegt nur im localStorage des Geraets, nie im Quelltext und
 * nie im Repository. Zur Verteilung an die Kollegen kann ein Link mit dem
 * Schluessel im Fragment (#schluessel=...) verschickt werden: Das Fragment
 * verlaesst den Browser nicht (es wird nicht an den Server uebertragen),
 * beim ersten Oeffnen wird der Schluessel uebernommen und aus der
 * Adresszeile entfernt.
 */

const ABLAGE = 'vn-gemini-schluessel'

export function leseSchluessel(): string {
  try {
    return localStorage.getItem(ABLAGE) ?? ''
  } catch {
    return ''
  }
}

export function speichereSchluessel(wert: string): void {
  try {
    if (wert) localStorage.setItem(ABLAGE, wert)
    else localStorage.removeItem(ABLAGE)
  } catch {
    /* privates Fenster o. ae. – dann gilt der Schluessel nur fuer diese Sitzung */
  }
}

/** Uebernimmt einen Schluessel aus dem Link (#schluessel=...) und raeumt die Adresszeile auf. */
export function uebernimmSchluesselAusLink(): string {
  const treffer = /[#&]schluessel=([^&]+)/.exec(window.location.hash)
  if (!treffer) return ''
  const wert = decodeURIComponent(treffer[1]).trim()
  if (wert) speichereSchluessel(wert)
  history.replaceState(null, '', window.location.pathname + window.location.search)
  return wert
}

/** Baut den Verteil-Link mit dem Schluessel im Fragment. */
export function verteilLink(schluessel: string): string {
  return `${window.location.origin}${window.location.pathname}#schluessel=${encodeURIComponent(schluessel)}`
}
