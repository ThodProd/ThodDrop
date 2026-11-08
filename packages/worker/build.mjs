import * as esbuild from 'esbuild'
import { readFileSync, mkdirSync } from 'node:fs'
const pkg = JSON.parse(readFileSync(new URL('../core/package.json', import.meta.url), 'utf8'))
mkdirSync(new URL('./dist/', import.meta.url), { recursive: true })
await esbuild.build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['bufferutil', 'utf-8-validate'],
  banner: { js: "const __import_meta_url = require('url').pathToFileURL(__filename).href;" },
  define: { 'import.meta.url': '__import_meta_url', __FLITDROP_VERSION__: JSON.stringify(pkg.version) },
  logLevel: 'warning',
})
console.log('worker bundle ok')
