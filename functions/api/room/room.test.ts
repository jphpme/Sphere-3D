// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it, vi } from 'vitest'
import { onRequest, type RoomEnv } from './[code]'

function call(opts: { code?: string; upgrade?: boolean; origin?: string | null; env?: RoomEnv }) {
  // A stand-in request: the test environment's own Request drops the
  // Upgrade and Origin headers, which are the two this route reads.
  const headers = new Map<string, string>()
  if (opts.upgrade !== false) headers.set('upgrade', 'websocket')
  if (opts.origin !== null) headers.set('origin', opts.origin ?? 'https://vr.example')
  const request = {
    url: `https://vr.example/api/room/${opts.code ?? 'AB12CD'}`,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
  }
  const context = { request, env: opts.env ?? {}, params: { code: opts.code ?? 'AB12CD' } }
  return onRequest(context as unknown as Parameters<typeof onRequest>[0])
}

function rooms() {
  const fetch = vi.fn(async () => new Response('handed over', { status: 200 }))
  const idFromName = vi.fn((name: string) => ({ name }))
  const namespace = { idFromName, get: vi.fn(() => ({ fetch })) }
  return { env: { ROOMS: namespace as unknown as DurableObjectNamespace }, fetch, idFromName }
}

describe('WS /api/room/:code', () => {
  it('hands a socket from this site to the room named by the code', async () => {
    const { env, fetch, idFromName } = rooms()
    const res = await call({ code: 'ab12cd', env })
    expect(await res.text()).toBe('handed over')
    expect(idFromName).toHaveBeenCalledWith('AB12CD')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('refuses a plain request, another site, and a non-code', async () => {
    const { env, fetch } = rooms()
    expect((await call({ upgrade: false, env })).status).toBe(426)
    expect((await call({ origin: 'https://elsewhere.example', env })).status).toBe(403)
    expect((await call({ origin: null, env })).status).toBe(403)
    expect((await call({ code: 'no', env })).status).toBe(400)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('says so when the deployment has no rooms', async () => {
    expect((await call({})).status).toBe(503)
  })
})
