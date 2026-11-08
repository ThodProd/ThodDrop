// Собирает ui/ для встроенного режима из готовых файлов ядра.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const out = process.argv[2]
const core = fileURLToPath(new URL('../core/public/', import.meta.url))
const here = fileURLToPath(new URL('./', import.meta.url))
const sdkCandidates = [
  process.env.THODHUB_SDK,
  fileURLToPath(new URL('../../sdk/thodhub.js', import.meta.url)),
  fileURLToPath(new URL('../../../ThodHUB/sdk/thodhub.js', import.meta.url)),
].filter(Boolean)
const sdk = sdkCandidates.find((file) => existsSync(file))
if (!sdk) throw new Error('Не найден sdk/thodhub.js: положите его в sdk/ или укажите THODHUB_SDK')
rmSync(out, { recursive: true, force: true })
mkdirSync(out + '/assets', { recursive: true })
cpSync(core + 'desktop/desktop.css', out + '/desktop.css')
cpSync(core + 'desktop/app.js', out + '/app.js')
cpSync(core + 'assets/icon.svg', out + '/assets/icon.svg')
cpSync(here + 'bridge.js', out + '/bridge.js')
cpSync(sdk, out + '/thodhub.js')
let html = readFileSync(core + 'desktop/index.html', 'utf8')
html = html.replace('href="/assets/icon.svg"', 'href="assets/icon.svg"')
html = html.replace('<script src="app.js"></script>', '<script src="thodhub.js"></script>\n  <script src="bridge.js"></script>')
if (!html.includes('bridge.js')) throw new Error('не удалось подставить bridge.js')
writeFileSync(out + '/index.html', html)
console.log('ui ok')
