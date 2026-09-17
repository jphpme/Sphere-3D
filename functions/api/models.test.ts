// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * `/api/models` is what the picker paints from and what the "Test
 * Connection" button checks, so it has to answer with exactly the catalog
 * the proxy resolves against. The drift it pairs with
 * `_lib/ai-models.test.ts` to prevent is historical: this endpoint used
 * to carry its own copy of the list, and the copy outlived two of the
 * models in it.
 */

import { describe, expect, it } from 'vitest'
import { modelIds } from './_lib/ai-models'
import { onRequestGet } from './models'

function ctx(env: Record<string, unknown> = { AI: {} }) {
  return {
    request: {
      url: 'https://localhost/api/models',
      headers: {
        get: (name: string) => (name.toLowerCase() === 'origin' ? 'http://localhost:5173' : null),
      },
    },
    env,
    params: {},
    data: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/models',
  } as unknown as Parameters<typeof onRequestGet>[0]
}

describe('GET /api/models', () => {
  it('publishes the catalog, in catalog order', async () => {
    const res = await onRequestGet(ctx())
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      object: string
      data: Array<{ id: string; object: string; owned_by: string }>
    }
    expect(body.object).toBe('list')
    expect(body.data.map(m => m.id)).toEqual(modelIds())
    for (const model of body.data) {
      expect(model.object).toBe('model')
      expect(model.owned_by).toBe('cloudflare')
    }
  })

  it('reports a missing AI binding as 503 rather than as an empty list', async () => {
    const res = await onRequestGet(ctx({}))
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('AI binding')
  })
})
