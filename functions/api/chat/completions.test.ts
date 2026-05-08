import { describe, expect, it, vi } from 'vitest'
import { onRequestPost } from './completions'

type Ctx = Parameters<typeof onRequestPost>[0]

function makeCtx(body: Record<string, unknown>, run: ReturnType<typeof vi.fn>): Ctx {
  const request = {
    url: 'https://vr.ayni.eu.com/api/chat/completions',
    headers: {
      get(name: string) {
        return name.toLowerCase() === 'origin' ? 'https://vr.ayni.eu.com' : null
      },
    },
    json: vi.fn(async () => body),
  }

  return {
    request,
    env: {
      AI: { run },
    },
  } as unknown as Ctx
}

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

describe('/api/chat/completions Gemma handling', () => {
  it('disables Gemma thinking mode before calling Workers AI', async () => {
    const run = vi.fn(async () => ({ response: 'ok' }))

    const res = await onRequestPost(makeCtx(toolBody(), run))
    const text = await res.text()

    expect(text).toContain('"content":"ok"')
    expect(run).toHaveBeenCalledWith(
      '@cf/google/gemma-4-26b-a4b-it',
      expect.objectContaining({
        chat_template_kwargs: { enable_thinking: false },
        reasoning_effort: null,
      }),
    )
  })

  it('streams text when Workers AI returns OpenAI-style choices content', async () => {
    const run = vi.fn(async () => ({
      choices: [{ message: { role: 'assistant', content: 'ok from choices' } }],
    }))

    const res = await onRequestPost(makeCtx(toolBody(), run))
    const text = await res.text()

    expect(text).toContain('"content":"ok from choices"')
    expect(text).toContain('data: [DONE]')
  })

  it('uses OpenAI-style choices content for non-streaming text responses', async () => {
    const run = vi.fn(async () => ({
      choices: [{ message: { role: 'assistant', content: 'ok nonstream' } }],
    }))

    const res = await onRequestPost(makeCtx({
      model: 'gemma-4-26b-a4b-it',
      stream: false,
      messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
    }, run))
    const json = await res.json() as { choices: Array<{ message: { content: string } }> }

    expect(json.choices[0].message.content).toBe('ok nonstream')
  })
})
