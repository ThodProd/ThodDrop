// Сборка пакета ThodDrop для ThodHUB: worker.exe + интерфейс + manifest.json,
// ZIP (manifest в корне, пути через /), thodhub-release.json (SHA-256, size).
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repo = process.env.THOD_REPO || 'ThodProd/ThodDrop'
const notes = process.env.THOD_NOTES || 'Первый выпуск: передача файлов и буфера обмена между телефоном и ПК. Основано на Flitdrop, без платных функций и статистики.'
const version = JSON.parse(readFileSync(path.join(root, 'packages/core/package.json'), 'utf8')).version
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Неверная версия: ' + version)

const work = path.join(root, 'dist-release')
const pkgDir = path.join(work, 'package')
const src = path.join(work, 'pkgsrc')
rmSync(work, { recursive: true, force: true })
mkdirSync(pkgDir + '/worker', { recursive: true })
mkdirSync(src + '/bin', { recursive: true })
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' })

run('npm', ['run', 'build'], path.join(root, 'packages/core'))
run('node', ['build.mjs'], path.join(root, 'packages/worker'))

// worker.exe (Node 22 внутри одного файла; статические файлы — в упаковке)
cpSync(path.join(root, 'packages/worker/dist/main.cjs'), src + '/bin/worker.cjs')
cpSync(path.join(root, 'packages/core/public'), src + '/public', { recursive: true })
writeFileSync(src + '/package.json', JSON.stringify({ name: 'thoddrop-worker', version, bin: 'bin/worker.cjs', pkg: { assets: ['public/**/*'], targets: ['node22-win-x64'] } }))
run(path.join(root, 'node_modules/.bin/pkg'), ['.', '--out-path', work + '/out', '--compress', 'GZip'], src)
cpSync(work + '/out/thoddrop-worker.exe', pkgDir + '/worker/ThodDropWorker.exe')

// интерфейс
run('node', [path.join(root, 'packages/ui/build-ui.mjs'), pkgDir + '/ui'], root)
cpSync(path.join(root, 'LICENSE'), pkgDir + '/LICENSE')
cpSync(path.join(root, 'NOTICE'), pkgDir + '/NOTICE')

const manifest = {
  schemaVersion: 1, hubApi: 1, id: 'thoddrop', version, platform: 'win-x64', mode: 'embedded',
  ui: 'ui/index.html',
  worker: { executable: 'worker/ThodDropWorker.exe', arguments: [] },
  permissions: ['settings', 'worker', 'clipboard.write'],
}
writeFileSync(pkgDir + '/manifest.json', JSON.stringify(manifest), { encoding: 'utf8' }) // UTF-8 без BOM

const name = `${manifest.id}-${version}-win-x64.zip`
const out = path.join(work, 'release')
mkdirSync(out, { recursive: true })
const zip = path.join(out, name)
run('zip', ['-r', '-X', '-q', zip, '.'], pkgDir)

const buf = readFileSync(zip)
const release = {
  version, packageUrl: `https://github.com/${repo}/releases/download/hub-v${version}/${name}`,
  sha256: createHash('sha256').update(buf).digest('hex'), size: statSync(zip).size,
  notes, platform: manifest.platform, hubApi: manifest.hubApi,
}
writeFileSync(path.join(out, 'thodhub-release.json'), JSON.stringify(release, null, 2), 'utf8')
console.log(JSON.stringify(release, null, 2))
