// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Route: POST /api/meeting — start a meeting (AYNI,
 * `docs/SHARED_AR_PLAN.md`): a room where only the presenter leads, and
 * everyone else watches.
 *
 * Checks that the caller may host (`mayHostMeeting`), mints a room code,
 * tells that room it is a meeting until the meeting's end, and returns
 * the three ways in:
 *
 *   - `presenter`: a signed link; whoever opens it drives the sphere;
 *   - `moderator`: a signed link, for the second person at the table;
 *   - `audience`: the plain room link, for everyone else.
 *
 *   401 — the caller may not host
 *   403 — an Origin that is not this site
 *   503 — rooms or the signing secret are not configured
 *   502 — the room refused to be declared a meeting
 */

import { isAllowedOrigin } from '../voice/_voice-lib'
import { newRoomCode } from '../../../src/services/roomProtocol'
import { MEETING_LIFETIME_MS, createMeetingToken, mayHostMeeting, type MeetingEnv } from './_meeting-lib'

export interface MeetingCreateEnv extends MeetingEnv {
  ROOMS?: DurableObjectNamespace
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })

/** A meeting's code: longer than an open room's, since it is the only thing between the audience link and a guess. */
function newMeetingCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10))
  let i = 0
  return newRoomCode(() => bytes[i++ % bytes.length] / 256) + newRoomCode(() => bytes[i++ % bytes.length] / 256).slice(0, 4)
}

export const onRequestPost: PagesFunction<MeetingCreateEnv> = async (context) => {
  const { request, env } = context
  if (!isAllowedOrigin(request.headers.get('Origin'), request.url)) return json({ error: 'forbidden_origin' }, 403)
  if (!mayHostMeeting(request, env)) return json({ error: 'unauthorized' }, 401)
  if (!env.ROOMS) return json({ error: 'rooms_unconfigured' }, 503)

  const code = newMeetingCode()
  const expiresAt = Date.now() + MEETING_LIFETIME_MS
  const [presenter, moderator] = await Promise.all([
    createMeetingToken(env, code, 'presenter', expiresAt),
    createMeetingToken(env, code, 'moderator', expiresAt),
  ])
  if (!presenter || !moderator) return json({ error: 'signing_unconfigured' }, 503)

  const declared = await env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(
    new Request('https://room/init', { method: 'POST', headers: { 'X-Meeting-Until': String(expiresAt) } }),
  )
  if (!declared.ok) return json({ error: 'room_refused' }, 502)

  const origin = new URL(request.url).origin
  const link = (token?: string): string =>
    `${origin}/?room=${code}${token ? `&st=${encodeURIComponent(token)}` : ''}`
  return json({
    code,
    expiresAt,
    links: { presenter: link(presenter), moderator: link(moderator), audience: link() },
  })
}
