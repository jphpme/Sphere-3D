/**
 * Cloudflare Pages Function - /api/voice/transcribe
 *
 * Accepts a short microphone recording and transcribes it through
 * Workers AI Whisper. The browser records audio; the server owns ASR.
 */

interface Env {
  AI?: {
    run(model: string, inputs: Record<string, unknown>): Promise<unknown>
  }
}

const TRANSCRIBE_MODEL = '@cf/openai/whisper-large-v3-turbo'
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

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

function extractTranscript(result: unknown): string {
  if (!result || typeof result !== 'object') return ''
  const obj = result as Record<string, unknown>
  const transcriptionInfo = obj.transcription_info && typeof obj.transcription_info === 'object'
    ? obj.transcription_info as Record<string, unknown>
    : {}
  const text = obj.text ?? transcriptionInfo.text
  return typeof text === 'string' ? text.trim() : ''
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
    const result = await context.env.AI.run(TRANSCRIBE_MODEL, {
      audio: arrayBufferToBase64(audio),
      task: 'transcribe',
      vad_filter: true,
      condition_on_previous_text: false,
    })
    const text = extractTranscript(result)
    if (!text) {
      return json({ error: 'No speech detected' }, 422, cors)
    }
    return json({ text }, 200, cors)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return json({ error: message || 'Transcription failed' }, 502, cors)
  }
}
