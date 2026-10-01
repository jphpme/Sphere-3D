// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it, vi } from 'vitest'
import { createMeeting, meetingKey, takeMeetingKeyParam } from './meetingHost'

/** A Storage with nothing behind it but a Map. */
function memoryStorage(): Storage {
  const items = new Map<string, string>()
  return {
    getItem: (k) => items.get(k) ?? null,
    setItem: (k, v) => { items.set(k, v) },
    removeItem: (k) => { items.delete(k) },
    clear: () => items.clear(),
    key: () => null,
    get length() { return items.size },
  }
}

describe('the host key', () => {
  it('is taken from the address, stored, and removed from the address', () => {
    const store = memoryStorage()
    expect(takeMeetingKeyParam('https://vr.example/?meetingKey=s3cret&room=AB12CD', store)).toBe('https://vr.example/?room=AB12CD')
    expect(meetingKey(store)).toBe('s3cret')
  })

  it('is forgotten with off', () => {
    const store = memoryStorage()
    takeMeetingKeyParam('https://vr.example/?meetingKey=s3cret', store)
    expect(takeMeetingKeyParam('https://vr.example/?meetingKey=off', store)).toBe('https://vr.example/')
    expect(meetingKey(store)).toBeNull()
  })

  it('leaves an address without one alone', () => {
    const store = memoryStorage()
    expect(takeMeetingKeyParam('https://vr.example/?room=AB12CD', store)).toBeNull()
    expect(meetingKey(store)).toBeNull()
  })
})

describe('createMeeting', () => {
  const meeting = {
    code: 'ABCDEFGH23',
    expiresAt: 1_900_000_000_000,
    links: { presenter: 'https://vr.example/?room=A&st=p', moderator: 'https://vr.example/?room=A&st=m', audience: 'https://vr.example/?room=A' },
  }
  const respond = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

  it('sends the key and returns the links', async () => {
    const fetchImpl = respond(200, meeting)
    expect(await createMeeting('s3cret', fetchImpl)).toEqual({ ok: true, meeting })
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/meeting')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['X-Meeting-Api-Key']).toBe('s3cret')
  })

  it('tells a refused key from a site that cannot host', async () => {
    expect(await createMeeting('wrong', respond(401, { error: 'unauthorized' }))).toEqual({ ok: false, reason: 'unauthorized' })
    expect(await createMeeting('s3cret', respond(503, { error: 'rooms_unconfigured' }))).toEqual({ ok: false, reason: 'unavailable' })
    expect(await createMeeting('s3cret', respond(200, { code: 'X' }))).toEqual({ ok: false, reason: 'unavailable' })
    const failing = vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch
    expect(await createMeeting('s3cret', failing)).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('does not ask at all without a key', async () => {
    const fetchImpl = respond(200, meeting)
    expect(await createMeeting(null, fetchImpl)).toEqual({ ok: false, reason: 'unauthorized' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
