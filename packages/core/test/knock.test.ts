import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startServer, type RunningServer } from '../src/server.js'
import { parsePairToken } from '../src/webclient/onboarding.js'
import { b64u } from '../src/util.js'
import { openJSON, randomToken, sealJSON } from '../src/crypto.js'

let srv: RunningServer
let base = ''
let home = ''

describe('demande d’accès par la lien rapide', () => {
  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-knock-'))
    srv = await startServer({ port: 0, home, disableClipboard: true })
    // le mode « lien rapide » est normalement activé depuis le PC ; ici on
    // teste uniquement le protocole de demande d'accès.
    srv.cfg.quickEnabled = true
    base = `http://127.0.0.1:${srv.port}`
  })

  afterAll(async () => {
    await srv.close()
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('approuve le téléphone et renvoie une lien dont le jeton est lisible', async () => {
    const secret = randomToken(32)

    const created = await fetch(base + '/api/phone/knock', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'iPhone test', platform: 'iphone', secret }),
    })
    expect(created.status).toBe(200)
    const { id, state } = (await created.json()) as { id: string; state: string }
    expect(state).toBe('pending')

    // la demande est visible sur le PC
    const stateRes = await fetch(base + '/api/admin/state', { headers: { 'x-admin-token': srv.adminToken } })
    const adminState = (await stateRes.json()) as { knocks?: Array<{ id: string }> }
    expect(adminState.knocks?.some((k) => k.id === id)).toBe(true)

    // clic « Разрешить » sur le PC
    const approved = await fetch(base + `/api/admin/quick/knock/${id}/approve`, {
      method: 'POST',
      headers: { 'x-admin-token': srv.adminToken },
    })
    expect(approved.status).toBe(200)

    // l'attente du téléphone reçoit enfin la lien (au lieu de rester bloquée)
    const poll = await fetch(base + `/api/phone/knock/${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret }),
    })
    expect(poll.status).toBe(200)
    const { state: after, url } = (await poll.json()) as { state: string; url?: string }
    expect(after).toBe('approved')
    expect(url).toMatch(/^http:\/\/.+\/s\/#/)
    const token = parsePairToken(url as string)
    expect(token?.id).toBe(id)

    // et ce jeton ouvre bien le hello, comme le fait la page du téléphone
    const phoneAad = (purpose: string) => `wd1|${token?.id}|${purpose}`
    const hello = await fetch(base + '/api/phone/hello', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-wd-device': token?.id as string },
      body: JSON.stringify({
        p: sealJSON(b64u.dec(token?.keyB64 as string), { ts: Date.now(), jti: randomToken(9) }, phoneAad('hello')),
      }),
    })
    expect(hello.status).toBe(200)
    const body = (await hello.json()) as { p: string }
    const dec = openJSON<{ instanceId?: string }>(b64u.dec(token?.keyB64 as string), body.p, phoneAad('hello:res'))
    expect(dec.instanceId).toBe(srv.cfg.instanceId)
  })
})
