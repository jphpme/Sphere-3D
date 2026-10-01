// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Route: WS /api/room/:code — the door to a shared session's room
 * (AYNI, `docs/SHARED_AR_PLAN.md`).
 *
 * The room itself is a Durable Object in the companion Worker
 * `workers/rooms`, bound here as `ROOMS`; this route only checks the
 * request and hands the socket over, one object per room code. Same-origin
 * by construction, so the page needs no second host and no CORS.
 *
 * It is also where a connection's seat is decided. A signed link's token
 * (`?st=`) that verifies for this room seats its bearer as presenter or
 * moderator; anyone else is audience. The seat travels to the room in the
 * `X-Room-Role` header, always set here and never taken from the caller,
 * which is what lets the room trust it. A token that does not verify is
 * refused rather than quietly demoted: someone holding a presenter link
 * that has expired should be told, not left watching their own meeting.
 *
 *   426 — not a WebSocket upgrade
 *   403 — an Origin that is not this site, or a token that does not verify
 *   400 — not a room code
 *   503 — the `ROOMS` binding is absent on this deployment
 */

import { isAllowedOrigin } from '../voice/_voice-lib'
import { normalizeRoomCode, type RoomSeat } from '../../../src/services/roomProtocol'
import { seatFromMeetingToken, type MeetingEnv } from '../meeting/_meeting-lib'

export interface RoomEnv extends MeetingEnv {
  ROOMS?: DurableObjectNamespace
}

export const onRequest: PagesFunction<RoomEnv> = async (context) => {
  const { request, env, params } = context
  if ((request.headers.get('Upgrade') ?? '').toLowerCase() !== 'websocket') {
    return new Response('expected websocket', { status: 426 })
  }
  if (!isAllowedOrigin(request.headers.get('Origin'), request.url)) {
    return new Response(null, { status: 403 })
  }
  const raw = Array.isArray(params.code) ? params.code[0] : params.code
  const code = normalizeRoomCode(raw)
  if (!code) return new Response('not a room code', { status: 400 })
  if (!env.ROOMS) return new Response('rooms are not configured', { status: 503 })

  let seat: RoomSeat = 'audience'
  const token = new URL(request.url).searchParams.get('st')
  if (token) {
    const signed = await seatFromMeetingToken(env, token, code)
    if (!signed) return new Response('this link is not valid for this meeting', { status: 403 })
    seat = signed
  }
  const headers = new Headers(request.headers)
  headers.set('X-Room-Role', seat)
  return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(new Request(request, { headers }))
}
