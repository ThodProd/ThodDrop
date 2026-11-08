// ThodDrop worker: запускает локальный сервер ThodDrop и отвечает хабу по
// JSON-RPC 2.0 (одна компактная строка на сообщение, stdin/stdout).
// stdout — только протокол; всё остальное пишется в stderr.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import crypto from 'node:crypto'
import { WebSocket } from 'ws'
import { startServer, checkWindowsFirewall, type RunningServer } from '../../core/src/server.js'
import { VERSION } from '../../core/src/constants.js'

// ничто не должно попасть в stdout, кроме ответов протокола
console.log = (...a: unknown[]) => console.error(...a)
console.info = console.log
console.warn = console.log

const dataDir = process.env.THODHUB_DATA_DIR || path.join(os.homedir(), '.thoddrop')
const coreHome = path.join(dataDir, 'core')
const cacheDir = path.join(dataDir, 'cache')
const uploadDir = path.join(cacheDir, 'upload-tmp')

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

// ---------- события сервера (WebSocket /ws/ui) -> буфер для опроса ----------

interface Ev {
  seq: number
  raw: string
}
const events: Ev[] = []
let seq = 0
const waiters = new Set<() => void>()
function pushEvent(raw: string): void {
  events.push({ seq: ++seq, raw })
  if (events.length > 500) events.splice(0, events.length - 500)
  for (const w of [...waiters]) w()
}

let srv: RunningServer | null = null
let ws: WebSocket | null = null
let closing = false

function connectEvents(): void {
  if (!srv || closing) return
  const base = `127.0.0.1:${srv.port}`
  const sock = new WebSocket(`ws://${base}/ws/ui?k=${encodeURIComponent(srv.adminToken)}`, { headers: { origin: `http://${base}` } })
  ws = sock
  sock.on('message', (d) => pushEvent(d.toString()))
  sock.on('close', () => {
    if (ws === sock) setTimeout(connectEvents, 1500)
  })
  sock.on('error', () => {})
}

// ---------- вызовы админского API ----------

const PATH_OK = /^\/api\/admin\/[A-Za-z0-9/_.\-?=&%:]*$/

async function adminHttp(p: { method?: string; path?: string; body?: string | null; contentType?: string | null }) {
  if (!srv) throw new Error('Сервер ещё запускается.')
  const method = p.method === 'POST' ? 'POST' : 'GET'
  const url = typeof p.path === 'string' ? p.path : ''
  if (!PATH_OK.test(url) || url.includes('..')) throw new Error('Недопустимый путь.')
  const headers: Record<string, string> = { 'x-admin-token': srv.adminToken }
  if (p.contentType) headers['content-type'] = p.contentType
  const res = await fetch(`http://127.0.0.1:${srv.port}${url}`, {
    method,
    headers,
    body: method === 'POST' && typeof p.body === 'string' ? p.body : undefined,
  })
  return { status: res.status, contentType: res.headers.get('content-type') ?? '', body: await res.text() }
}

async function pollEvents(p: { since?: number }) {
  const since = typeof p.since === 'number' ? p.since : 0
  const ready = () => events.filter((e) => e.seq > since)
  if (ready().length === 0 && !closing) {
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        waiters.delete(done)
        resolve()
      }
      const timer = setTimeout(done, 20_000)
      waiters.add(done)
    })
  }
  const list = ready()
  return { last: list.length ? list[list.length - 1]!.seq : since, events: list.map((e) => e.raw) }
}

// ---------- отправка файлов с ПК на телефон (частями) ----------

const uploads = new Map<string, { file: string; name: string; size: number; got: number; at: number }>()
const MAX_UPLOADS = 8

function safeName(n: unknown): string {
  const s = String(n ?? 'file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 180).trim()
  return s || 'file'
}

function sweepUploads(): void {
  const now = Date.now()
  for (const [id, u] of uploads) {
    if (now - u.at > 60 * 60 * 1000) {
      fs.rm(u.file, { force: true }, () => {})
      uploads.delete(id)
    }
  }
}

function uploadBegin(p: { name?: string; size?: number }) {
  sweepUploads()
  if (uploads.size >= MAX_UPLOADS) throw new Error('Слишком много одновременных отправок.')
  fs.mkdirSync(uploadDir, { recursive: true })
  const id = crypto.randomBytes(8).toString('hex')
  const file = path.join(uploadDir, id + '.part')
  fs.writeFileSync(file, '')
  uploads.set(id, { file, name: safeName(p.name), size: Number(p.size) || 0, got: 0, at: Date.now() })
  return { id }
}

function uploadChunk(p: { id?: string; data?: string }) {
  const u = uploads.get(String(p.id))
  if (!u || typeof p.data !== 'string') throw new Error('Отправка не найдена.')
  const buf = Buffer.from(p.data, 'base64')
  fs.appendFileSync(u.file, buf)
  u.got += buf.length
  u.at = Date.now()
  return { got: u.got }
}

async function uploadEnd(p: { id?: string; to?: string | null }) {
  if (!srv) throw new Error('Сервер ещё запускается.')
  const id = String(p.id)
  const u = uploads.get(id)
  if (!u) throw new Error('Отправка не найдена.')
  uploads.delete(id)
  try {
    const fd = new FormData()
    fd.append('file', await fs.openAsBlob(u.file), u.name)
    const q = p.to ? `?to=${encodeURIComponent(String(p.to))}` : ''
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/admin/outbox/file${q}`, {
      method: 'POST',
      headers: { 'x-admin-token': srv.adminToken },
      body: fd,
    })
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { code?: string }
      throw new Error(j.code === 'tooBig' ? 'Файл больше допустимого размера.' : `Не удалось принять файл (код ${res.status}).`)
    }
    return { ok: true }
  } finally {
    fs.rm(u.file, { force: true }, () => {})
  }
}

// ---------- RPC ----------

type Handler = (params: any) => unknown | Promise<unknown>
const methods: Record<string, Handler> = {
  status: () => ({ ready: !!srv, version: VERSION, port: srv?.port ?? null }),
  http: adminHttp,
  events: pollEvents,
  'upload.begin': uploadBegin,
  'upload.chunk': uploadChunk,
  'upload.end': uploadEnd,
}

async function handleLine(line: string): Promise<void> {
  let req: { id?: unknown; method?: unknown; params?: unknown }
  try {
    req = JSON.parse(line)
  } catch {
    return
  }
  if (typeof req.id !== 'string') return
  const id = req.id
  try {
    const h = typeof req.method === 'string' ? methods[req.method] : undefined
    if (!h) throw new Error('Неизвестный метод.')
    send({ jsonrpc: '2.0', id, result: (await h(req.params ?? {})) ?? null })
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: { code: -32000, message: (e as Error).message || 'Ошибка.' } })
  }
}

async function shutdown(): Promise<void> {
  if (closing) return
  closing = true
  for (const w of [...waiters]) w()
  try {
    ws?.close()
  } catch {
    // уже закрыт
  }
  const t = setTimeout(() => process.exit(0), 1500)
  try {
    await srv?.close()
  } catch {
    // выходим в любом случае
  }
  clearTimeout(t)
  process.exit(0)
}

async function main(): Promise<void> {
  fs.mkdirSync(coreHome, { recursive: true })
  fs.mkdirSync(cacheDir, { recursive: true })
  // остатки прерванных отправок
  fs.rmSync(uploadDir, { recursive: true, force: true })

  const rl = readline.createInterface({ input: process.stdin })
  rl.on('line', (l) => void handleLine(l))
  rl.on('close', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
  process.on('SIGINT', () => void shutdown())

  srv = await startServer({
    home: coreHome,
    quiet: true,
    // проверка брандмауэра Windows: только диагностика. Правила и права
    // администратора worker не меняет (постоянная интеграция запрещена
    // контрактом хаба), пользователю показываются шаги для ручной настройки.
    firewall:
      process.platform === 'win32'
        ? { check: (ip) => checkWindowsFirewall({ exe: process.execPath, ip }), repair: async () => 'failed' }
        : undefined,
  })
  connectEvents()
  console.error(`ThodDrop worker ${VERSION}: порт ${srv.port}`)
}

main().catch((e) => {
  console.error('Запуск не удался:', (e as Error).message)
  process.exit(1)
})
