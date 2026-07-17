import { describe, expect, it } from 'vitest'
import { loginTarget, sameOriginReturnTo, sanitizeTeamDomain } from './login'

describe('account login helpers', () => {
  it('keeps return_to on the request origin', () => {
    const req = new Request('https://vr.ayni.eu.com/api/v1/account/login?return_to=https%3A%2F%2Fevil.example%2F')
    expect(sameOriginReturnTo(req)).toBe('https://vr.ayni.eu.com/')
  })

  it('allows same-origin return_to URLs', () => {
    const req = new Request('https://vr.ayni.eu.com/api/v1/account/login?return_to=%2F%3Fdataset%3Dabc')
    expect(sameOriginReturnTo(req)).toBe('https://vr.ayni.eu.com/?dataset=abc')
  })

  it('sanitizes Cloudflare Access team domains', () => {
    expect(sanitizeTeamDomain('https://team.cloudflareaccess.com/')).toBe('team.cloudflareaccess.com')
    expect(sanitizeTeamDomain('bad domain')).toBeNull()
  })

  it('builds a Cloudflare Access login URL from env', () => {
    expect(loginTarget({
      ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
      ACCESS_AUD: 'aud123',
    }, 'https://vr.ayni.eu.com/')).toBe(
      'https://team.cloudflareaccess.com/cdn-cgi/access/login/aud123?redirect_url=https%3A%2F%2Fvr.ayni.eu.com%2F',
    )
  })

  it('uses ACCOUNT_LOGIN_URL when configured', () => {
    expect(loginTarget({
      ACCOUNT_LOGIN_URL: 'https://login.example/start?next={return_to}',
    }, 'https://vr.ayni.eu.com/')).toBe(
      'https://login.example/start?next=https%3A%2F%2Fvr.ayni.eu.com%2F',
    )
  })

  it('rejects invalid explicit login URLs', () => {
    expect(loginTarget({
      ACCOUNT_LOGIN_URL: 'not a url',
    }, 'https://vr.ayni.eu.com/')).toBeNull()
  })
})
