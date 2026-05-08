/**
 * Cloudflare Pages Function - /api/voice/speak
 *
 * Accepts response text and returns generated speech audio. This is separate
 * from transcription because gpt-4o-transcribe is ASR-only.
 */

interface Env {
  AI?: {
    run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>
  }
}

const TTS_MODEL = '@cf/deepgram/aura-2-en'
const MAX_TEXT_LENGTH = 1800
const ALLOWED_ORIGINS = new Set([
  'http://localhost:5173',
  'http://localhost:4173',
])

function isAllowedOrigin(origin: string | null, requestUrl: string): boolean {
  if (!origin) return false
  if (ALLOWED_ORIGINS.has(origin)) return true
  try {
    const req = new URL(requestUrl)
    return origin === req.origin
  } catch {
    return false
  }
}

function corsHeaders(origin?: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  }
  if (origin) headers['Access-Control-Allow-Origin'] = origin
  return headers
}

function json(data: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  })
}

function cleanText(text: string): string {
  return text
    .replace(/<?<(LOAD|FLY|TIME|BOUNDS|MARKER|LABELS|REGION):[^>]+>>?\n?/g, '')
    .replace(/\[\[LOAD:[^\]]+\]\]/g, '')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/[*_`>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT_LENGTH)
}

export const onRequestOptions: PagesFunction<Env> = async (context) => {
  const origin = context.request.headers.get('Origin')
  if (!isAllowedOrigin(origin, context.request.url)) {
    return new Response(null, { status: 403 })
  }
  return new Response(null, { status: 204, headers: corsHeaders(origin) })
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const origin = context.request.headers.get('Origin')
  if (!origin || !isAllowedOrigin(origin, context.request.url)) {
    return new Response(null, { status: 403 })
  }
  const cors = corsHeaders(origin)

  if (!context.env.AI) {
    return json({ error: 'AI binding not configured' }, 503, cors)
  }

  const body = await context.request.json().catch(() => ({})) as { text?: unknown }
  const text = cleanText(typeof body.text === 'string' ? body.text : '')
  if (!text) {
    return json({ error: 'Text is required' }, 400, cors)
  }

  try {
    const audio = await context.env.AI.run(TTS_MODEL, {
      text,
      speaker: 'luna',
      encoding: 'mp3',
    }, {
      returnRawResponse: true,
    })
    if (audio instanceof Response) {
      return new Response(audio.body, {
        status: audio.status,
        headers: {
          ...cors,
          'Content-Type': audio.headers.get('Content-Type') || 'audio/mpeg',
          'Cache-Control': 'no-store',
        },
      })
    }
    return json({ error: 'Speech model returned no audio' }, 502, cors)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return json({ error: message || 'Speech synthesis failed' }, 502, cors)
  }
}
