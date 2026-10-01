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
 *   426 — not a WebSocket upgrade
 *   403 — an Origin that is not this site
 *   400 — not a room code
 *   503 — the `ROOMS` binding is absent on this deployment
 */

import { isAllowedOrigin } from '../voice/_voice-lib'
import { normalizeRoomCode } from '../../../src/services/roomProtocol'

export interface RoomEnv {
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
  return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(request)
}
