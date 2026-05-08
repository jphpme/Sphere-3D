type RealtimeProxyEnv = {
  REALTIME_DASH_ORIGIN?: string
}

const DEFAULT_REALTIME_DASH_ORIGIN = 'https://pachamama-studios.stream'
const CACHE_CONTROL = 'public, max-age=300, stale-while-revalidate=3600'

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
  headers.set('Access-Control-Allow-Headers', 'Range, If-None-Match, If-Modified-Since')
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

  const requestUrl = new URL(context.request.url)
  const origin = (context.env.REALTIME_DASH_ORIGIN || DEFAULT_REALTIME_DASH_ORIGIN).replace(/\/$/, '')
  const upstreamUrl = `${origin}/${namespace}/${assetPath}${requestUrl.search}`

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
