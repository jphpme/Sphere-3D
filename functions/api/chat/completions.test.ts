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
