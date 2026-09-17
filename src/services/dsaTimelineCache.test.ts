// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect, vi } from 'vitest'
import { createDsaTimelineCache } from './dsaTimelineCache'

const DSA = {
  schemaVersion: '1.6',
  timeEnabled: true,
  timeRange: { start: '2026-08-18T14:30:00Z', end: '2026-09-17T14:30:00Z' },
  timeRangeEndMode: 'exclusive',
  timeTotalFrames: 2880,
  timeCadenceSeconds: 900,
  videoFrameRate: 24,
}

/** Minimal Response stand-in — the cache only reads ok/status/json. */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

function makeFetch(handler: (url: string) => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL) => handler(String(input)))
}

const URL_A = 'https://example.test/a/a.dsa'

describe('createDsaTimelineCache', () => {
  it('fetches once, parses, and answers synchronously afterwards', async () => {
    const fetchImpl = makeFetch(() => jsonResponse(DSA))
    const cache = createDsaTimelineCache({ fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(cache.get(URL_A)).toBeNull()
    cache.prefetch(URL_A)
    expect(cache.isPending(URL_A)).toBe(true)
    const timeline = await cache.load(URL_A)
    expect(timeline?.frameCount).toBe(2880)
    expect(cache.get(URL_A)).toBe(timeline)
    expect(cache.isPending(URL_A)).toBe(false)
    expect(cache.isSettled(URL_A)).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('joins concurrent callers onto one request', async () => {
    let release: (() => void) | null = null
    const gate = new Promise<void>(resolve => { release = resolve })
    const fetchImpl = makeFetch(async () => {
      await gate
      return jsonResponse(DSA)
    })
    const cache = createDsaTimelineCache({ fetchImpl: fetchImpl as unknown as typeof fetch })
    const first = cache.load(URL_A)
    const second = cache.load(URL_A)
    cache.prefetch(URL_A)
    release!()
    const [a, b] = await Promise.all([first, second])
    expect(a).toBe(b)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('remembers a 404 and does not ask again', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({}, 404))
    const cache = createDsaTimelineCache({ fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(await cache.load(URL_A)).toBeNull()
    cache.prefetch(URL_A)
    cache.prefetch(URL_A)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(cache.isSettled(URL_A)).toBe(true)
    expect(cache.get(URL_A)).toBeNull()
  })

  it('remembers a body that is not JSON, and one with no time block', async () => {
    const html = makeFetch(() => ({ ok: true, status: 200, json: async () => { throw new Error('not json') } }) as unknown as Response)
    const broken = createDsaTimelineCache({ fetchImpl: html as unknown as typeof fetch })
    expect(await broken.load(URL_A)).toBeNull()
    expect(html).toHaveBeenCalledTimes(1)

    const noTime = makeFetch(() => jsonResponse({ schemaVersion: '1.6', timeEnabled: false }))
    const cache = createDsaTimelineCache({ fetchImpl: noTime as unknown as typeof fetch })
    expect(await cache.load(URL_A)).toBeNull()
    expect(cache.isSettled(URL_A)).toBe(true)
  })

  it('keeps a network rejection inside the cache', async () => {
    const fetchImpl = makeFetch(() => { throw new Error('offline') })
    const cache = createDsaTimelineCache({ fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(cache.load(URL_A)).resolves.toBeNull()
  })

  it('keys by URL, so two rows sharing an annotation share the fetch', async () => {
    const fetchImpl = makeFetch(() => jsonResponse(DSA))
    const cache = createDsaTimelineCache({ fetchImpl: fetchImpl as unknown as typeof fetch })
    const [a, b] = await Promise.all([cache.load(URL_A), cache.load(URL_A)])
    expect(a).toBe(b)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('is inert when there is no fetch at all, and never reaches the network', async () => {
    const globalSpy = vi.spyOn(globalThis, 'fetch')
    const cache = createDsaTimelineCache({ fetchImpl: null })
    expect(await cache.load(URL_A)).toBeNull()
    expect(cache.get(URL_A)).toBeNull()
    expect(globalSpy).not.toHaveBeenCalled()
    globalSpy.mockRestore()
  })

  it('ignores an empty URL', async () => {
    const fetchImpl = makeFetch(() => jsonResponse(DSA))
    const cache = createDsaTimelineCache({ fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(await cache.load('')).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
