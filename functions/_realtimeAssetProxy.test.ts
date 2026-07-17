import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { verifyAccessJwt } from './api/v1/_lib/access-auth'
import { proxyRealtimeDashAsset } from './_realtimeAssetProxy'

vi.mock('./api/v1/_lib/access-auth', () => ({
  verifyAccessJwt: vi.fn(),
}))

const verifyAccessJwtMock = vi.mocked(verifyAccessJwt)

interface KvLike extends KVNamespace {
  store: Map<string, string>
}

function makeKv(): KvLike {
  const store = new Map<string, string>()
  return {
    store,
    get: vi.fn(async (key: string, type?: unknown) => {
      const value = store.get(key)
      if (value == null) return null
      return type === 'json' ? JSON.parse(value) : value
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value)
    }),
  } as unknown as KvLike
}

function makeContext(
  path: string,
  env: Record<string, unknown>,
  init: RequestInit = {},
): EventContext<Record<string, unknown>, string, Record<string, unknown>> {
  const request = {
    method: init.method ?? 'GET',
    url: `https://vr.ayni.eu.com/dash/${path}`,
    headers: new Headers(init.headers),
  } as unknown as Request

  return {
    request,
    env,
    params: { path },
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    next: vi.fn(),
    data: {},
    functionPath: '/dash/[[path]]',
  } as unknown as EventContext<Record<string, unknown>, string, Record<string, unknown>>
}

describe('proxyRealtimeDashAsset', () => {
  beforeEach(() => {
    verifyAccessJwtMock.mockReset()
    verifyAccessJwtMock.mockResolvedValue(null)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('asset', {
        headers: { 'Content-Type': 'video/webm' },
      })) as unknown as typeof fetch,
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('proxies relative realtime paths without exposing the upstream URL', async () => {
    const env = { REALTIME_QUOTA_KV: makeKv() }
    const res = await proxyRealtimeDashAsset(
      makeContext('global/realtime/noaa/clouds/stream.mpd', env),
    )

    expect(res.status).toBe(200)
    expect(fetch).toHaveBeenCalledWith(
      'https://pachamama-studios.stream/global/realtime/noaa/clouds/stream.mpd',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(res.headers.get('Set-Cookie')).toContain('ayni_rt_visitor=')
  })

  it('does not consume realtime quota for forecasts', async () => {
    const kv = makeKv()
    const res = await proxyRealtimeDashAsset(
      makeContext('global/forecast/ecmwf-era5/aod550/chunk.webm', {
        REALTIME_QUOTA_KV: kv,
      }),
    )

    expect(res.status).toBe(200)
    expect(kv.put).not.toHaveBeenCalled()
  })

  it('returns 429 when realtime segment quota is exhausted', async () => {
    const kv = makeKv()
    const env = {
      REALTIME_QUOTA_KV: kv,
      REALTIME_FREE_WEEKLY_SECONDS: '20',
      REALTIME_QUOTA_SEGMENT_SECONDS: '10',
    }
    const headers = { cookie: 'ayni_rt_visitor=00000000-0000-4000-8000-000000000000' }
    const path = 'global/realtime/noaa/clouds/chunk-1.webm'

    expect((await proxyRealtimeDashAsset(makeContext(path, env, { headers }))).status).toBe(200)
    expect((await proxyRealtimeDashAsset(makeContext(path, env, { headers }))).status).toBe(200)
    expect(kv.store.size).toBe(1)
    const blocked = await proxyRealtimeDashAsset(makeContext(path, env, { headers }))

    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toMatchObject({ error: 'realtime_quota_exceeded' })
  })

  it('keys realtime quota by a verified Access identity', async () => {
    verifyAccessJwtMock.mockResolvedValue({
      email: 'reader@example.com',
      sub: 'google-oauth2|123',
      type: 'user',
    })
    const kv = makeKv()
    const res = await proxyRealtimeDashAsset(
      makeContext('global/realtime/noaa/clouds/chunk-1.webm', {
        ACCESS_AUD: 'aud123',
        ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
        REALTIME_QUOTA_KV: kv,
      }, {
        headers: { 'Cf-Access-Jwt-Assertion': 'jwt' },
      }),
    )

    expect(res.status).toBe(200)
    expect(verifyAccessJwtMock).toHaveBeenCalledWith('jwt', expect.any(Object))
    expect([...kv.store.keys()][0]).toContain(':user:google-oauth2|123')
    expect(res.headers.get('Set-Cookie')).toBeNull()
  })

  it('requires a KV binding for charged realtime segment requests', async () => {
    const res = await proxyRealtimeDashAsset(
      makeContext('global/realtime/noaa/clouds/chunk-1.webm', {}),
    )

    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: 'quota_unconfigured' })
  })
})
