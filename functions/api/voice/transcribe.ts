/**
 * Cloudflare Pages Function - /api/voice/transcribe
 *
 * Accepts a short microphone recording and transcribes it through Workers AI.
 * The browser records audio; the server owns ASR.
 */

interface Env {
  AI?: {
    run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>
  }
}

const TRANSCRIBE_MODEL = '@cf/deepgram/nova-3'
const MAX_AUDIO_BYTES = 5 * 1024 * 1024
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

function extractTranscript(result: unknown): string {
  if (!result || typeof result !== 'object') return ''
  const obj = result as Record<string, unknown>
  const results = obj.results && typeof obj.results === 'object'
    ? obj.results as Record<string, unknown>
    : {}
  const channels = Array.isArray(results.channels) ? results.channels : []
  const firstChannel = channels[0] && typeof channels[0] === 'object'
    ? channels[0] as Record<string, unknown>
    : {}
  const alternatives = Array.isArray(firstChannel.alternatives) ? firstChannel.alternatives : []
  const firstAlternative = alternatives[0] && typeof alternatives[0] === 'object'
    ? alternatives[0] as Record<string, unknown>
    : {}
  const transcriptionInfo = obj.transcription_info && typeof obj.transcription_info === 'object'
    ? obj.transcription_info as Record<string, unknown>
    : {}
  const text = obj.text ?? transcriptionInfo.text ?? firstAlternative.transcript
  return typeof text === 'string' ? text.trim() : ''
}

async function parseRawResponse(result: unknown): Promise<unknown> {
  if (!(result instanceof Response)) return result
  const contentType = result.headers.get('Content-Type') || ''
  if (contentType.includes('application/json')) {
    return await result.json().catch(() => ({}))
  }
  return { text: await result.text().catch(() => '') }
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

  const contentLength = Number(context.request.headers.get('Content-Length') ?? '0')
  if (contentLength > MAX_AUDIO_BYTES) {
    return json({ error: 'Audio recording is too large' }, 413, cors)
  }

  const audio = await context.request.arrayBuffer()
  if (audio.byteLength === 0) {
    return json({ error: 'Empty audio recording' }, 400, cors)
  }
  if (audio.byteLength > MAX_AUDIO_BYTES) {
    return json({ error: 'Audio recording is too large' }, 413, cors)
  }

  try {
    const contentType = context.request.headers.get('Content-Type')?.split(';')[0] || 'audio/webm'
    const result = await context.env.AI.run(
      TRANSCRIBE_MODEL,
      {
        audio: {
          body: new Response(audio).body,
          contentType,
        },
        detect_language: true,
        punctuate: true,
        smart_format: true,
      },
      { returnRawResponse: true },
    )
    const parsed = await parseRawResponse(result)
    const text = extractTranscript(parsed)
    if (!text) {
      return json({ error: 'No speech detected' }, 422, cors)
    }
    return json({ text }, 200, cors)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return json({ error: message || 'Transcription failed' }, 502, cors)
  }
}
