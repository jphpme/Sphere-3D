// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it, vi } from 'vitest'
import { createMeetingToken, mayHostMeeting, seatFromMeetingToken } from './_meeting-lib'
import { onRequestPost, type MeetingCreateEnv } from './index'
import { onRequest as roomDoor } from '../room/[code]'

const env = { MEETING_API_KEY: 'host-key', MEETING_SIGNING_SECRET: 'signing-secret' }

/** A stand-in request: the test environment's own Request drops the headers these routes read. */
function request(url: string, headers: Record<string, string>): Request {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  return {
    url,
    method: 'POST',
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
  } as unknown as Request
}

describe('mayHostMeeting', () => {
  const ask = (key?: string) => request('https://vr.example/api/meeting', key ? { 'X-Meeting-Api-Key': key } : {})

  it('lets the holder of the key host, and nobody else', () => {
    expect(mayHostMeeting(ask('host-key'), env)).toBe(true)
    expect(mayHostMeeting(ask('host-kez'), env)).toBe(false)
    expect(mayHostMeeting(ask('host-key-and-more'), env)).toBe(false)
    expect(mayHostMeeting(ask(), env)).toBe(false)
  })

  it('lets nobody host where no key is configured', () => {
    expect(mayHostMeeting(ask('anything'), {})).toBe(false)
    expect(mayHostMeeting(ask(''), { MEETING_API_KEY: '' })).toBe(false)
  })
})

describe('meeting tokens', () => {
  const later = 2_000_000

  it('seat their bearer in the room they were made for', async () => {
    const token = (await createMeetingToken(env, 'ROOM1234', 'presenter', later))!
    expect(await seatFromMeetingToken(env, token, 'ROOM1234', 1_000_000)).toBe('presenter')
    const moderator = (await createMeetingToken(env, 'ROOM1234', 'moderator', later))!
    expect(await seatFromMeetingToken(env, moderator, 'ROOM1234', 1_000_000)).toBe('moderator')
  })

  it('are refused in another room, after their time, or when altered', async () => {
    const token = (await createMeetingToken(env, 'ROOM1234', 'moderator', later))!
    expect(await seatFromMeetingToken(env, token, 'OTHER123', 1_000_000)).toBeNull()
    expect(await seatFromMeetingToken(env, token, 'ROOM1234', later + 1)).toBeNull()
    // A moderator's token rewritten to say presenter keeps the moderator's signature.
    expect(await seatFromMeetingToken(env, token.replace('.moderator.', '.presenter.'), 'ROOM1234', 1_000_000)).toBeNull()
    // Its expiry pushed back, likewise.
    expect(await seatFromMeetingToken(env, token.replace(String(later), String(later * 2)), 'ROOM1234', 1_000_000)).toBeNull()
    expect(await seatFromMeetingToken(env, 'ROOM1234.presenter.9999999999999.AAAA', 'ROOM1234', 1_000_000)).toBeNull()
    expect(await seatFromMeetingToken(env, 'nonsense', 'ROOM1234', 1_000_000)).toBeNull()
    expect(await seatFromMeetingToken(env, null, 'ROOM1234', 1_000_000)).toBeNull()
  })

  it('are refused under another site’s secret, and unsignable with none', async () => {
    const token = (await createMeetingToken(env, 'ROOM1234', 'presenter', later))!
    expect(await seatFromMeetingToken({ MEETING_SIGNING_SECRET: 'other' }, token, 'ROOM1234', 1_000_000)).toBeNull()
    expect(await createMeetingToken({}, 'ROOM1234', 'presenter', later)).toBeNull()
    expect(await seatFromMeetingToken({}, token, 'ROOM1234', 1_000_000)).toBeNull()
  })

  it('never seat anyone as audience: that link is unsigned', async () => {
    const forged = 'ROOM1234.audience.9999999999999.AAAA'
    expect(await seatFromMeetingToken(env, forged, 'ROOM1234', 1_000_000)).toBeNull()
  })
})

function rooms() {
  const calls: { url: string; until: string | null; role: string | null }[] = []
  const fetch = vi.fn(async (req: Request) => {
    calls.push({ url: req.url, until: req.headers.get('X-Meeting-Until'), role: req.headers.get('X-Room-Role') })
    return new Response(null, { status: 204 })
  })
  const idFromName = vi.fn((name: string) => ({ name }))
  const namespace = { idFromName, get: vi.fn(() => ({ fetch })) }
  return { ROOMS: namespace as unknown as DurableObjectNamespace, calls, idFromName }
}

describe('POST /api/meeting', () => {
  const post = (headers: Record<string, string>, e: MeetingCreateEnv) =>
    onRequestPost({
      request: request('https://vr.example/api/meeting', { Origin: 'https://vr.example', ...headers }),
      env: e,
    } as unknown as Parameters<typeof onRequestPost>[0])

  it('declares a room a meeting and returns the three ways in', async () => {
    const r = rooms()
    const res = await post({ 'X-Meeting-Api-Key': 'host-key' }, { ...env, ROOMS: r.ROOMS })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { code: string; expiresAt: number; links: Record<string, string> }
    expect(body.code).toMatch(/^[A-Z0-9]{10}$/)
    expect(r.idFromName).toHaveBeenCalledWith(body.code)
    expect(r.calls[0]).toMatchObject({ url: 'https://room/init', until: String(body.expiresAt) })
    expect(body.links.audience).toBe(`https://vr.example/?room=${body.code}`)
    // Each signed link seats its bearer where it says, in this room.
    const tokenOf = (link: string) => new URL(link).searchParams.get('st')
    expect(await seatFromMeetingToken(env, tokenOf(body.links.presenter), body.code)).toBe('presenter')
    expect(await seatFromMeetingToken(env, tokenOf(body.links.moderator), body.code)).toBe('moderator')
  })

  it('refuses a caller without the key, and another site', async () => {
    const r = rooms()
    expect((await post({}, { ...env, ROOMS: r.ROOMS })).status).toBe(401)
    expect((await post({ 'X-Meeting-Api-Key': 'wrong' }, { ...env, ROOMS: r.ROOMS })).status).toBe(401)
    expect((await post({ 'X-Meeting-Api-Key': 'host-key', Origin: 'https://elsewhere.example' }, { ...env, ROOMS: r.ROOMS })).status).toBe(403)
    expect(r.calls).toHaveLength(0)
  })

  it('says so where rooms are not configured', async () => {
    expect((await post({ 'X-Meeting-Api-Key': 'host-key' }, env)).status).toBe(503)
  })
})

describe('WS /api/room/:code, seating', () => {
  const join = (query: string, headers: Record<string, string>, e: object) =>
    roomDoor({
      request: request(`https://vr.example/api/room/ROOM1234${query}`, { Upgrade: 'websocket', Origin: 'https://vr.example', ...headers }),
      env: e,
      params: { code: 'ROOM1234' },
    } as unknown as Parameters<typeof roomDoor>[0])

  // The door rebuilds the request with the seat header; give it a Request that can be rebuilt.
  const withRebuild = async (run: () => Response | Promise<Response>): Promise<Response> => {
    const Original = globalThis.Request
    globalThis.Request = class {
      url: string
      headers: Headers
      constructor(input: { url: string }, init: { headers: Headers }) {
        this.url = input.url
        this.headers = init.headers
      }
    } as unknown as typeof Request
    try {
      return await run()
    } finally {
      globalThis.Request = Original
    }
  }

  it('seats a plain visitor as audience, whatever they claim', async () => {
    const r = rooms()
    await withRebuild(() => join('', { 'X-Room-Role': 'presenter' }, { ...env, ROOMS: r.ROOMS }))
    expect(r.calls[0].role).toBe('audience')
  })

  it('seats the bearer of a signed link where the link says', async () => {
    const r = rooms()
    const token = (await createMeetingToken(env, 'ROOM1234', 'presenter', Date.now() + 60_000))!
    await withRebuild(() => join(`?st=${encodeURIComponent(token)}`, {}, { ...env, ROOMS: r.ROOMS }))
    expect(r.calls[0].role).toBe('presenter')
  })

  it('turns away a link that does not verify, rather than demoting it', async () => {
    const r = rooms()
    const expired = (await createMeetingToken(env, 'ROOM1234', 'presenter', Date.now() - 1))!
    const res = await withRebuild(() => join(`?st=${encodeURIComponent(expired)}`, {}, { ...env, ROOMS: r.ROOMS }))
    expect(res.status).toBe(403)
    expect(r.calls).toHaveLength(0)
  })
})
