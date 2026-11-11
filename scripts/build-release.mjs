// Сборка пакета ThodDrop для ThodHUB: worker.exe + интерфейс + manifest.json,
// ZIP (manifest в корне, пути через /), thodhub-release.json (SHA-256, size).
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { ZipFile } from 'yazl'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repo = process.env.THOD_REPO || 'ThodProd/ThodDrop'
const notes = process.env.THOD_NOTES || 'Быстрый приём по постоянной ссылке: маленький агент, QR для iPhone, заявка на доступ и текст в папку Text. Обычная передача файлов и QR-код работают как раньше.'
const version = JSON.parse(readFileSync(path.join(root, 'packages/core/package.json'), 'utf8')).version
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Неверная версия: ' + version)

const work = path.join(root, 'dist-release')
const pkgDir = path.join(work, 'package')
const src = path.join(work, 'pkgsrc')
rmSync(work, { recursive: true, force: true })
mkdirSync(pkgDir + '/worker', { recursive: true })
mkdirSync(src + '/bin', { recursive: true })
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' })

// ZIP с путями через «/» (Windows-архиваторы пишут «\»): yazl нормализует.
async function makeZip(dir, file) {
  const zip = new ZipFile()
  const add = (d, prefix) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      const full = path.join(d, e.name)
      if (e.isDirectory()) add(full, rel)
      else if (e.isFile()) zip.addFile(full, rel)
    }
  }
  add(dir, '')
  zip.end()
  await pipeline(zip.outputStream, createWriteStream(file))
}

run(process.execPath, ['build.mjs'], path.join(root, 'packages/core'))
run(process.execPath, ['build.mjs'], path.join(root, 'packages/worker'))

// worker.exe: Windows — Node SEA (без загрузки base-бинарников и bytecode),
// другие платформы — прежний pkg.
const bundle = path.join(root, 'packages/worker/dist/main.cjs')
if (process.platform === 'win32') {
  const sea = path.join(work, 'sea')
  mkdirSync(sea, { recursive: true })
  const seaConfig = path.join(sea, 'sea-config.json')
  writeFileSync(seaConfig, JSON.stringify({
    main: bundle,
    output: path.join(sea, 'worker.blob'),
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
    useSnapshot: false,
  }))
  run(process.execPath, ['--experimental-sea-config', seaConfig], root)
  cpSync(process.execPath, pkgDir + '/worker/ThodDropWorker.exe')
  run(process.execPath, [path.join(root, 'node_modules/postject/dist/cli.js'), pkgDir + '/worker/ThodDropWorker.exe',
    'NODE_SEA_BLOB', path.join(sea, 'worker.blob'), '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'], root)
  // статические файлы телефона лежат рядом с worker/ (PUBLIC_DIR = ../public)
  cpSync(path.join(root, 'packages/core/public'), pkgDir + '/public', { recursive: true })
} else {
  cpSync(bundle, src + '/bin/worker.cjs')
  cpSync(path.join(root, 'packages/core/public'), src + '/public', { recursive: true })
  writeFileSync(src + '/package.json', JSON.stringify({ name: 'thoddrop-worker', version, bin: 'bin/worker.cjs', pkg: { assets: ['public/**/*'], targets: ['node22-win-x64'] } }))
  run(process.execPath, [path.join(root, 'node_modules/@yao-pkg/pkg/lib-es5/bin.js'), '.', '--out-path', work + '/out', '--compress', 'GZip', '--public-packages', '*', '--public'], src)
  cpSync(work + '/out/thoddrop-worker.exe', pkgDir + '/worker/ThodDropWorker.exe')
}

// маленький агент быстрого приёма: самостоятельный exe рядом с worker/
run('dotnet', [
  'publish', path.join(root, 'agent/ThodDropAgent.csproj'),
  '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true',
  '-p:PublishSingleFile=true', '-p:PublishTrimmed=true', '-p:TrimMode=partial',
  '-p:SuppressTrimAnalysisWarnings=true',
  '-o', pkgDir + '/agent',
], root)

// интерфейс
run(process.execPath, [path.join(root, 'packages/ui/build-ui.mjs'), pkgDir + '/ui'], root)
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
await makeZip(pkgDir, zip)

const buf = readFileSync(zip)
const release = {
  version, packageUrl: `https://github.com/${repo}/releases/download/hub-v${version}/${name}`,
  sha256: createHash('sha256').update(buf).digest('hex'), size: statSync(zip).size,
  notes, platform: manifest.platform, hubApi: manifest.hubApi,
}
writeFileSync(path.join(out, 'thodhub-release.json'), JSON.stringify(release, null, 2), 'utf8')
console.log(JSON.stringify(release, null, 2))
