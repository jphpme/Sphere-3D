import { verifyAccessJwt } from './api/v1/_lib/access-auth'

type RealtimeProxyEnv = {
  ACCESS_AUD?: string
  ACCESS_TEAM_DOMAIN?: string
  CATALOG_KV?: KVNamespace
  REALTIME_DASH_ORIGIN?: string
  REALTIME_FREE_WEEKLY_SECONDS?: string
  REALTIME_QUOTA_KV?: KVNamespace
  REALTIME_QUOTA_SEGMENT_SECONDS?: string
  REALTIME_QUOTA_SIGNING_KEY?: string
}

const DEFAULT_REALTIME_DASH_ORIGIN = 'https://pachamama-studios.stream'
const CACHE_CONTROL = 'public, max-age=300, stale-while-revalidate=3600'
const COOKIE_NAME = 'ayni_rt_visitor'
const DEFAULT_WEEKLY_ALLOWANCE_SECONDS = 20 * 60
const DEFAULT_SEGMENT_SECONDS = 10
const VISITOR_ID_RE = /^[0-9a-f-]{36}$/i
const WEEK_SECONDS = 7 * 24 * 60 * 60
const FREE_ASSET_RE = /\.(?:mpd|m3u8|dsa|json|png|jpe?g|webp|gif|svg|vtt|srt|txt)$/i

function responseHeaders(upstream: Response): Headers {
  const headers = new Headers()
  const passthrough = [
    'Accept-Ranges',
    'Content-Length',
    'Content-Range',
    'Content-Type',
    'ETag',
    'Last-Modified',
  ]
  for (const key of passthrough) {
    const value = upstream.headers.get(key)
    if (value) headers.set(key, value)
  }
  headers.set('Cache-Control', upstream.headers.get('Cache-Control') ?? CACHE_CONTROL)
  headers.set('Access-Control-Allow-Origin', '*')
  headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
  headers.set('Access-Control-Allow-Headers', 'Range, If-None-Match, If-Modified-Since, Content-Type')
  headers.set('Vary', 'Origin')
  return headers
}

function cleanPath(pathParam: string | string[] | undefined): string | null {
  if (!pathParam) return null
  const segments = Array.isArray(pathParam) ? pathParam : pathParam.split('/')
  const clean: string[] = []

  for (const segment of segments) {
    let decoded: string
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      return null
    }
    if (
      decoded === '' ||
      decoded === '.' ||
      decoded === '..' ||
      decoded.includes('/') ||
      decoded.includes('\\')
    ) {
      return null
    }
    clean.push(segment)
  }

  return clean.join('/')
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function getCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get('Cookie')
  if (!cookie) return null
  for (const part of cookie.split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=')
    if (rawKey === name) return rawValue.join('=') || null
  }
  return null
}

function base64url(bytes: ArrayBuffer): string {
  const data = String.fromCharCode(...new Uint8Array(bytes))
  return btoa(data).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function signVisitorId(id: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return base64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(id)))
}

async function resolveVisitorId(
  request: Request,
  secret: string | undefined,
): Promise<{ id: string; setCookie?: string }> {
  const cookie = getCookie(request, COOKIE_NAME)
  if (cookie) {
    const [id, signature] = cookie.split('.')
    if (VISITOR_ID_RE.test(id) && (!secret || signature === await signVisitorId(id, secret))) {
      return { id }
    }
  }

  const id = crypto.randomUUID()
  const value = secret ? `${id}.${await signVisitorId(id, secret)}` : id
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : ''
  return {
    id,
    setCookie: `${COOKIE_NAME}=${value}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax${secure}`,
  }
}

interface QuotaRecord {
  usedSeconds: number
  updatedAt: string
}

async function quotaSubject(
  context: EventContext<RealtimeProxyEnv, string, Record<string, unknown>>,
): Promise<{ key: string; setCookie?: string }> {
  const token = context.request.headers.get('Cf-Access-Jwt-Assertion')
  if (token && context.env.ACCESS_TEAM_DOMAIN && context.env.ACCESS_AUD) {
    const identity = await verifyAccessJwt(token, context.env)
    if (identity) return { key: `${identity.type}:${identity.sub}` }
  }
  const visitor = await resolveVisitorId(context.request, context.env.REALTIME_QUOTA_SIGNING_KEY)
  return { key: `visitor:${visitor.id}`, setCookie: visitor.setCookie }
}

function quotaExceededResponse(remainingSeconds: number): Response {
  const headers = responseHeaders(new Response())
  headers.set('Content-Type', 'application/json')
  headers.set('Cache-Control', 'no-store')
  headers.set('Retry-After', String(Math.max(1, remainingSeconds)))
  return new Response(
    JSON.stringify({
      error: 'realtime_quota_exceeded',
      message: 'Free real-time allowance exhausted. Try again next week or upgrade your plan.',
    }),
    { status: 429, headers },
  )
}

function shouldChargeRealtimeRequest(namespace: 'realtime' | 'forecast', method: string, assetPath: string): boolean {
  if (namespace !== 'realtime') return false
  if (method !== 'GET') return false
  return !FREE_ASSET_RE.test(assetPath)
}

async function consumeRealtimeQuota(
  context: EventContext<RealtimeProxyEnv, string, Record<string, unknown>>,
): Promise<{ ok: true; setCookie?: string } | { ok: false; response: Response }> {
  const kv = context.env.REALTIME_QUOTA_KV
  if (!kv) {
    const headers = responseHeaders(new Response())
    headers.set('Content-Type', 'application/json')
    headers.set('Cache-Control', 'no-store')
    return {
      ok: false,
      response: new Response(
        JSON.stringify({
          error: 'quota_unconfigured',
          message: 'REALTIME_QUOTA_KV must be configured before real-time streams can be served.',
        }),
        { status: 503, headers },
      ),
    }
  }

  const allowance = parsePositiveInt(
    context.env.REALTIME_FREE_WEEKLY_SECONDS,
    DEFAULT_WEEKLY_ALLOWANCE_SECONDS,
  )
  const chargeSeconds = parsePositiveInt(
    context.env.REALTIME_QUOTA_SEGMENT_SECONDS,
    DEFAULT_SEGMENT_SECONDS,
  )
  const now = Date.now()
  const week = Math.floor(now / (WEEK_SECONDS * 1000))
  const nextWeekMs = (week + 1) * WEEK_SECONDS * 1000
  const subject = await quotaSubject(context)
  const key = `realtime-quota:v1:${week}:${subject.key}`
  const current = (await kv.get(key, 'json')) as QuotaRecord | null
  const usedSeconds = Math.max(0, current?.usedSeconds ?? 0)

  if (usedSeconds + chargeSeconds > allowance) {
    return {
      ok: false,
      response: quotaExceededResponse(Math.ceil((nextWeekMs - now) / 1000)),
    }
  }

  const next: QuotaRecord = {
    usedSeconds: usedSeconds + chargeSeconds,
    updatedAt: new Date(now).toISOString(),
  }
  await kv.put(key, JSON.stringify(next), { expirationTtl: WEEK_SECONDS + 2 * 24 * 60 * 60 })
  return { ok: true, setCookie: subject.setCookie }
}

function namespaceFromPath(path: string): 'realtime' | 'forecast' | null {
  if (path === 'realtime' || path.startsWith('realtime/') || path.includes('/realtime/')) return 'realtime'
  if (path === 'forecast' || path.startsWith('forecast/') || path.includes('/forecast/')) return 'forecast'
  return null
}

async function proxyAsset(
  context: EventContext<RealtimeProxyEnv, string, Record<string, unknown>>,
  namespace: 'realtime' | 'forecast',
  upstreamPath: string,
): Promise<Response> {
  if (shouldChargeRealtimeRequest(namespace, context.request.method, upstreamPath)) {
    const quota = await consumeRealtimeQuota(context)
    if (!quota.ok) return quota.response
    const response = await fetchUpstreamAsset(context, namespace, upstreamPath)
    if (quota.setCookie) response.headers.append('Set-Cookie', quota.setCookie)
    return response
  }

  const response = await fetchUpstreamAsset(context, namespace, upstreamPath)
  if (namespace === 'realtime' && context.request.method === 'GET') {
    const visitor = await resolveVisitorId(context.request, context.env.REALTIME_QUOTA_SIGNING_KEY)
    if (visitor.setCookie) response.headers.append('Set-Cookie', visitor.setCookie)
  }
  return response
}

async function fetchUpstreamAsset(
  context: EventContext<RealtimeProxyEnv, string, Record<string, unknown>>,
  namespace: 'realtime' | 'forecast',
  upstreamPath: string,
): Promise<Response> {
  const requestUrl = new URL(context.request.url)
  const origin = (context.env.REALTIME_DASH_ORIGIN || DEFAULT_REALTIME_DASH_ORIGIN).replace(/\/$/, '')
  const upstreamUrl = `${origin}/${upstreamPath}${requestUrl.search}`

  const headers = new Headers()
  for (const key of ['Range', 'If-None-Match', 'If-Modified-Since']) {
    const value = context.request.headers.get(key)
    if (value) headers.set(key, value)
  }

  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl, {
      method: context.request.method,
      headers,
      cf: {
        cacheEverything: true,
        cacheTtl: namespace === 'forecast' ? 3600 : 300,
      },
    } as RequestInit)
  } catch {
    return new Response(`Failed to fetch ${namespace} asset`, { status: 502 })
  }

  return new Response(context.request.method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders(upstream),
  })
}

export async function proxyRealtimeAsset(
  context: EventContext<RealtimeProxyEnv, string, Record<string, unknown>>,
  namespace: 'realtime' | 'forecast',
): Promise<Response> {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: responseHeaders(new Response()),
    })
  }

  if (context.request.method !== 'GET' && context.request.method !== 'HEAD') {
    return new Response('Method not allowed', {
      status: 405,
      headers: { Allow: 'GET, HEAD, OPTIONS' },
    })
  }

  const assetPath = cleanPath(context.params.path as string | string[] | undefined)
  if (!assetPath) return new Response('Invalid asset path', { status: 400 })

  return proxyAsset(context, namespace, `${namespace}/${assetPath}`)
}

export async function proxyRealtimeDashAsset(
  context: EventContext<RealtimeProxyEnv, string, Record<string, unknown>>,
): Promise<Response> {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: responseHeaders(new Response()),
    })
  }

  if (context.request.method !== 'GET' && context.request.method !== 'HEAD') {
    return new Response('Method not allowed', {
      status: 405,
      headers: { Allow: 'GET, HEAD, OPTIONS' },
    })
  }

  const assetPath = cleanPath(context.params.path as string | string[] | undefined)
  if (!assetPath) return new Response('Invalid asset path', { status: 400 })
  const namespace = namespaceFromPath(assetPath)
  if (!namespace) return new Response('Unknown DASH asset namespace', { status: 404 })

  return proxyAsset(context, namespace, assetPath)
}
