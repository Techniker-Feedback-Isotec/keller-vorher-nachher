import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// BASE_PATH wird im GitHub-Actions-Workflow automatisch auf "/<repo-name>/"
// gesetzt. Lokal (dev) laeuft die App unter "/".
//
// GEMINI_SCHLUESSEL kommt aus dem Actions-Geheimnis und wird beim Bauen
// KODIERT ins Programm geschrieben (Zeichen umgekehrt, dann Base64). Grund:
// Das gebaute Programm liegt im oeffentlichen gh-pages-Branch, und GitHub
// meldet dort gefundene Google-Schluessel automatisch an Google, das sie
// sofort sperrt (passiert am 04.09.2026). Die Kodierung verhindert nur diese
// automatische Erkennung, sie ist kein Schutz vor Menschen, die gezielt
// nachsehen. Bewusst KEIN VITE_-Praefix, damit Vite den Klartext nie selbst
// ins Programm schreibt.
function kodiereSchluessel(klartext: string | undefined): string {
  const wert = (klartext ?? '').trim()
  if (!wert) return ''
  return Buffer.from(wert.split('').reverse().join(''), 'utf8').toString('base64')
}

export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: command === 'build' ? process.env.BASE_PATH ?? '/keller-vorher-nachher/' : '/',
  server: { port: Number(process.env.PORT) || 5180 },
  define: {
    __GEMINI_SCHLUESSEL_KODIERT__: JSON.stringify(kodiereSchluessel(process.env.GEMINI_SCHLUESSEL)),
  },
}))
