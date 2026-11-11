import { describe, expect, it } from 'vitest'
import { parsePairToken } from '../src/webclient/onboarding.js'

// 32 octets en base64url : même longueur qu'un vrai jeton.
const KEY = 'k'.repeat(43)

describe('jeton d’appairage', () => {
  it('accepte le fragment brut et le jeton nu', () => {
    expect(parsePairToken(`#device01.${KEY}.pc01`)).toEqual({ id: 'device01', keyB64: KEY, instanceId: 'pc01' })
    expect(parsePairToken(`device01.${KEY}`)).toEqual({ id: 'device01', keyB64: KEY })
  })

  it('accepte le lien complet renvoyé par le QR ou la demande d’accès', () => {
    expect(parsePairToken(`http://192.168.1.5:47776/s/#device01.${KEY}.pc01`)).toEqual({
      id: 'device01',
      keyB64: KEY,
      instanceId: 'pc01',
    })
    // ancien raccourci avec ?k=
    expect(parsePairToken(`http://192.168.1.5:47776/s/?k=device01.${KEY}`)).toEqual({ id: 'device01', keyB64: KEY })
  })

  it('refuse un lien sans jeton ou un jeton incomplet', () => {
    expect(parsePairToken('')).toBeNull()
    expect(parsePairToken('http://192.168.1.5:47776/s/')).toBeNull()
    expect(parsePairToken('http://192.168.1.5:47776/s/#bad')).toBeNull()
    expect(parsePairToken('garbage')).toBeNull()
  })
})
