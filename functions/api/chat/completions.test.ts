// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Wire-level tests for the /api/chat/completions proxy's reply-envelope
 * handling.
 *
 * The Gemma 4 block covers the model routing on top of that: Gemma
 * deliberates unless the chat template's thinking flag is cleared, it is
 * deliberately not a tool-calling model (so the proxy strips `tools`),
 * and it streams `choices[0].delta` chunks that the shared extractor —
 * which reads `message.content` — would drop, arriving as a blank reply.
 *
 * The latent bug this guards: the non-streaming and shim paths used to
 * read `result.response ?? ''` directly, which silently yields an empty
 * assistant message when the model answers in the OpenAI-compatible
 * `{ choices: [{ message: { content } }] }` envelope (llama-4-scout was
 * observed doing exactly that live during slice-C enrichment testing).
 * All paths now go through the shared `workers-ai-text` extractor.
 */

import { describe, expect, it, vi } from 'vitest'
import { onRequestPost } from './completions'

type AiRun = (model: string, inputs: Record<string, unknown>, options?: unknown) => Promise<unknown>

function ctx(opts: { body: unknown; run: AiRun }) {
  const url = 'https://localhost/api/chat/completions'
  // A stub rather than a real Request: happy-dom emulates the browser's
  // forbidden-header rules and silently strips `Origin`, which the route
  // requires for its CORS allowlist gate.
  const request = {
    url,
    method: 'POST',
    headers: {
      get: (name: string) => (name.toLowerCase() === 'origin' ? 'http://localhost:5173' : null),
    },
    json: async () => opts.body,
  } as unknown as Request
  return {
    request,
    env: { AI: { run: opts.run } },
    params: {},
    data: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/chat/completions',
  } as unknown as Parameters<typeof onRequestPost>[0]
}

const MESSAGES = [{ role: 'user', content: 'hi' }]

describe('POST /api/chat/completions — non-streaming envelope handling', () => {
  it('reads the classic { response } envelope', async () => {
    const run = vi.fn(async () => ({ response: 'classic reply' }))
    const res = await onRequestPost(ctx({ body: { messages: MESSAGES, stream: false }, run }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> }
    expect(body.choices[0].message.content).toBe('classic reply')
  })

  it('reads the OpenAI choices[].message.content envelope (scout drift)', async () => {
    const run = vi.fn(async () => ({
      choices: [{ message: { role: 'assistant', content: 'scout reply' } }],
    }))
    const res = await onRequestPost(ctx({ body: { messages: MESSAGES, stream: false }, run }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> }
    expect(body.choices[0].message.content).toBe('scout reply')
  })
})

describe('POST /api/chat/completions — tool shim envelope handling', () => {
  const TOOLS = [{ type: 'function', function: { name: 'load_dataset', parameters: {} } }]

  it('emits tool_calls SSE chunks from the OpenAI-nested envelope', async () => {
    const run = vi.fn(async () => ({
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Loading that now.',
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'load_dataset', arguments: '{"id":"DS1"}' } },
            ],
          },
        },
      ],
    }))
    const res = await onRequestPost(
      ctx({ body: { model: 'llama-4-scout', messages: MESSAGES, stream: true, tools: TOOLS }, run }),
    )
    expect(res.status).toBe(200)
    const sse = await res.text()
    expect(sse).toContain('"content":"Loading that now."')
    expect(sse).toContain('"name":"load_dataset"')
    expect(sse).toContain('"finish_reason":"tool_calls"')
  })

  it('still handles the classic top-level { response, tool_calls } shape', async () => {
    const run = vi.fn(async () => ({
      response: 'On it.',
      tool_calls: [{ name: 'load_dataset', arguments: { id: 'DS2' } }],
    }))
    const res = await onRequestPost(
      ctx({ body: { model: 'llama-4-scout', messages: MESSAGES, stream: true, tools: TOOLS }, run }),
    )
    expect(res.status).toBe(200)
    const sse = await res.text()
    expect(sse).toContain('"content":"On it."')
    expect(sse).toContain('"arguments":"{\\"id\\":\\"DS2\\"}"')
    expect(sse).toContain('"finish_reason":"tool_calls"')
  })
})

describe('POST /api/chat/completions — Gemma 4 routing', () => {
  // Gemma 4 is deliberately absent from TOOL_CALLING_MODELS, so the
  // proxy strips the request's tools and this body lands on the
  // plain-text streaming path. That stripping is half of what the first
  // case asserts.
  function toolBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      model: 'gemma-4-26b-a4b-it',
      stream: true,
      messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
      tools: [{
        type: 'function',
        function: {
          name: 'search_datasets',
          description: 'Search datasets',
          parameters: { type: 'object', properties: {} },
        },
      }],
      ...overrides,
    }
  }

  // A Workers AI raw SSE stream, the shape returnRawResponse: true hands
  // back. Built with concatenation rather than a nested template so the
  // JSON payload stays quoted as the model wrote it.
  function rawStream(...payloads: string[]): Response {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          payloads.map(payload => 'data: ' + payload + '\n\n').join('') + 'data: [DONE]\n\n',
        ))
        controller.close()
      },
    })
    return new Response(stream)
  }

  it('disables Gemma thinking mode before calling Workers AI', async () => {
    const run = vi.fn(async () => rawStream('{"response":"ok"}'))
    const res = await onRequestPost(ctx({ body: toolBody(), run }))
    const text = await res.text()

    expect(text).toContain('"content":"ok"')
    expect(run).toHaveBeenCalledWith(
      '@cf/google/gemma-4-26b-a4b-it',
      expect.objectContaining({
        stream: true,
        chat_template_kwargs: { enable_thinking: false },
        reasoning_effort: null,
      }),
      { returnRawResponse: true },
    )
    const inputs = (run as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as unknown as Record<string, unknown>
    expect(inputs).not.toHaveProperty('tools')
  })

  it('streams text when Workers AI raw stream returns OpenAI-style choices content', async () => {
    const run = vi.fn(async () => rawStream('{"choices":[{"delta":{"content":"ok from choices"}}]}'))
    const res = await onRequestPost(ctx({ body: toolBody(), run }))
    const text = await res.text()

    expect(text).toContain('"content":"ok from choices"')
    expect(text).toContain('data: [DONE]')
  })

  it('streams text when a tool-capable Workers AI model returns choices content', async () => {
    const run = vi.fn(async () => ({
      choices: [{ message: { role: 'assistant', content: 'ok from choices' } }],
    }))

    const res = await onRequestPost(ctx({ body: toolBody({ model: 'llama-4-scout' }), run }))
    const text = await res.text()

    expect(text).toContain('"content":"ok from choices"')
    expect(text).toContain('data: [DONE]')
  })

  it('uses OpenAI-style choices content for non-streaming text responses', async () => {
    const run = vi.fn(async () => ({
      choices: [{ message: { role: 'assistant', content: 'ok nonstream' } }],
    }))

    const res = await onRequestPost(ctx({
      body: {
        model: 'gemma-4-26b-a4b-it',
        stream: false,
        messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
      },
      run,
    }))
    const json = await res.json() as { choices: Array<{ message: { content: string } }> }

    expect(json.choices[0].message.content).toBe('ok nonstream')
  })
})

describe('POST /api/chat/completions — upstream failures on the streaming path', () => {
  // `returnRawResponse: true` means a failed Workers AI call comes back as a
  // Response rather than a throw. Before this guard the transformer read that
  // error body as if it were SSE, skipped every line of it, and closed an empty
  // stream — which the client rendered as "the model said nothing": two
  // retries, the local engine, and a "check LLM settings" banner. On an
  // exhausted neuron budget that is the wrong story to tell an operator.
  function plainBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      model: 'llama-3.2-3b',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
      ...overrides,
    }
  }

  it('turns an exhausted neuron budget into the typed 503 the SPA degrades on', async () => {
    const run = vi.fn(async () => new Response(
      JSON.stringify({
        error: '4006: you have used up your daily free allocation of 10,000 neurons',
      }),
      { status: 429 },
    ))

    const res = await onRequestPost(ctx({ body: plainBody(), run }))

    expect(res.status).toBe(503)
    const json = await res.json() as { error: { type: string; code: number; message: string } }
    expect(json.error.type).toBe('quota_exhausted')
    expect(json.error.code).toBe(4006)
    expect(json.error.message).toContain('4006')
  })

  it('reports any other upstream failure as a 502, with what the upstream said', async () => {
    // Deliberately not a quota signal: the classifier is conservative about
    // load-shedding, which is a wait-for-the-incident answer, not an upgrade one.
    const run = vi.fn(async () => new Response(
      'Capacity temporarily exceeded for this model',
      { status: 503 },
    ))

    const res = await onRequestPost(ctx({ body: plainBody(), run }))

    expect(res.status).toBe(502)
    const json = await res.json() as { error: { type: string; message: string } }
    expect(json.error.type).toBe('server_error')
    expect(json.error.message).toContain('Capacity temporarily exceeded')
  })

  // The production signature: 200, `text/event-stream`, a body that closes
  // without a byte in it. Not `new Response('')`, which has no body at all and
  // takes the older `!response.body` branch instead.
  function emptyStream(): Response {
    return new Response(new ReadableStream({ start(controller) { controller.close() } }))
  }

  it('classifies an empty upstream stream as quota when the budget is spent', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce(emptyStream())
      .mockRejectedValueOnce(
        new Error('4006: you have used up your daily free allocation of 10,000 neurons'),
      )

    const res = await onRequestPost(ctx({ body: plainBody(), run }))

    expect(res.status).toBe(503)
    const json = await res.json() as { error: { type: string; code: number } }
    expect(json.error.type).toBe('quota_exhausted')
    expect(json.error.code).toBe(4006)
    // The classification is a second, 1-token call — and only on this path.
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('does not blame the budget for an empty stream it cannot explain', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce(emptyStream())
      .mockResolvedValueOnce({ response: 'ok' })

    const res = await onRequestPost(ctx({ body: plainBody(), run }))

    expect(res.status).toBe(502)
    const json = await res.json() as { error: { type: string; message: string } }
    expect(json.error.type).toBe('server_error')
    expect(json.error.message).toContain('empty stream')
  })

  it('leaves a healthy raw stream alone', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"response":"still streaming"}\n\ndata: [DONE]\n\n',
        ))
        controller.close()
      },
    })
    const run = vi.fn(async () => new Response(stream))

    const res = await onRequestPost(ctx({ body: plainBody(), run }))
    const text = await res.text()

    expect(res.status).toBe(200)
    expect(text).toContain('"content":"still streaming"')
    expect(text).toContain('data: [DONE]')
  })
})
