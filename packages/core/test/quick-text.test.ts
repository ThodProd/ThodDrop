import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startServer, type RunningServer } from '../src/server.js'
import { b64u } from '../src/util.js'
import { openJSON, randomToken, sealJSON } from '../src/crypto.js'

interface Phone {
  id: string
  key: Uint8Array
  aad: (purpose: string, extra?: string) => string
  post: (p: string, purpose: string, obj: Record<string, unknown>) => Promise<Response>
}

let srv: RunningServer
let base = ''
let home = ''
const revealed: string[] = []

function phoneFrom(id: string, key: Uint8Array): Phone {
  const aad = (purpose: string, extra = '') => `wd1|${id}|${purpose}${extra ? '|' + extra : ''}`
  const post = (p: string, purpose: string, obj: Record<string, unknown>) =>
    fetch(base + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-wd-device': id },
      body: JSON.stringify({ p: sealJSON(key, { ...obj, ts: Date.now(), jti: randomToken(9) }, aad(purpose)) }),
    })
  return { id, key, aad, post }
}

async function pairPhone(): Promise<Phone> {
  const r = await fetch(base + '/api/admin/pair/new', {
    method: 'POST',
    headers: { 'x-admin-token': srv.adminToken },
  })
  const { url } = (await r.json()) as { url: string }
  const [id, k] = (url.split('#')[1] as string).split('.')
  const phone = phoneFrom(id as string, b64u.dec(k as string))
  const h = await phone.post('/api/phone/hello', 'hello', { deviceLabel: 'Pixel', platform: 'android' })
  const dec = openJSON<{ newKey?: string }>(phone.key, ((await h.json()) as { p: string }).p, phone.aad('hello:res'))
  return dec.newKey ? phoneFrom(phone.id, b64u.dec(dec.newKey)) : phone
}

describe('texte reçu par la lien rapide', () => {
  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-quick-text-'))
    process.env.FLITDROP_DOWNLOADS = path.join(home, 'dl')
    srv = await startServer({
      port: 0,
      home,
      disableClipboard: true,
      openReceived: (p) => revealed.push(p),
    })
    srv.cfg.openReceived = true
    base = `http://127.0.0.1:${srv.port}`
  })
  afterAll(async () => {
    await srv.close()
    delete process.env.FLITDROP_DOWNLOADS
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('enregistre le texte dans Text/ et demande à ouvrir le dossier', async () => {
    const phone = await pairPhone()
    const text = `Привет из теста ${randomToken(6)}`
    const res = await phone.post('/api/phone/text', 'text', { text, mode: 'clip' })
    expect(res.status).toBe(200)
    const body = openJSON<{ ok: boolean; copied: boolean; savedName?: string }>(
      phone.key,
      ((await res.json()) as { p: string }).p,
      phone.aad('text:res')
    )
    expect(body.ok).toBe(true)
    expect(body.savedName).toMatch(/^text-\d{4}-\d{2}-\d{2}-\d{6}\.txt$/)
    const file = path.join(srv.cfg.downloadDir, 'Text', body.savedName as string)
    expect(fs.readFileSync(file, 'utf8')).toBe(text)
    // l'ouverture du dossier est différée de 700 ms pour ne pas lancer un
    // Explorer par texte reçu d'affilée
    await new Promise((r) => setTimeout(r, 900))
    expect(revealed).toContain(file)
  })
})
