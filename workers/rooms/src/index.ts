// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * AYNI — the room of a shared session (`docs/SHARED_AR_PLAN.md`): one
 * Durable Object per room code, relaying the lead's state to everyone
 * else over WebSockets.
 *
 * A separate Worker because a Pages project cannot define a Durable
 * Object class; the site reaches it through the `ROOMS` binding
 * (`functions/api/room/[code].ts`). Deployed by hand, not by CI:
 *
 *   npx wrangler deploy --config workers/rooms/wrangler.toml
 *
 * The rules, all enforced here rather than trusted to the browser:
 *
 *   - the lead is whoever has been connected longest; when it leaves,
 *     the next longest takes over;
 *   - only the lead's messages are relayed, and only if they parse as a
 *     state (`roomProtocol.ts`);
 *   - a room holds at most ROOM_MAX_PEOPLE.
 *
 * Nothing is stored. The latest state is kept in memory for people
 * arriving mid-session, and the lead repeats it every second, so a room
 * that was evicted is whole again within one beat. Sockets use the
 * hibernation API, with each connection's id and join time in its
 * attachment, so who leads survives an eviction too.
 */

import { DurableObject } from 'cloudflare:workers'
import {
  ROOM_MAX_PEOPLE,
  normalizeRoomCode,
  parseClientMessage,
  type RoomServerMessage,
  type RoomState,
} from '../../../src/services/roomProtocol'

export interface Env {
  ROOMS: DurableObjectNamespace<Room>
}

interface Seat {
  id: string
  joinedAt: number
}

export class Room extends DurableObject<Env> {
  /** The lead's latest state; lost on eviction, restored by the lead's next beat. */
  private last: RoomState | null = null

  private seats(): { socket: WebSocket; seat: Seat }[] {
    const seats: { socket: WebSocket; seat: Seat }[] = []
    for (const socket of this.ctx.getWebSockets()) {
      const seat = socket.deserializeAttachment() as Seat | null
      if (seat) seats.push({ socket, seat })
    }
    return seats
  }

  /** The id of the longest-connected participant, skipping `without`. */
  private leadId(without?: WebSocket): string | null {
    let lead: Seat | null = null
    for (const { socket, seat } of this.seats()) {
      if (socket === without) continue
      if (!lead || seat.joinedAt < lead.joinedAt || (seat.joinedAt === lead.joinedAt && seat.id < lead.id)) {
        lead = seat
      }
    }
    return lead?.id ?? null
  }

  private send(socket: WebSocket, message: RoomServerMessage): void {
    try {
      socket.send(JSON.stringify(message))
    } catch {
      // The socket is closing; its close event does the bookkeeping.
    }
  }

  private broadcastRoster(without?: WebSocket): void {
    const seats = this.seats().filter(({ socket }) => socket !== without)
    const lead = this.leadId(without)
    for (const { socket } of seats) this.send(socket, { t: 'roster', lead, count: seats.length })
  }

  async fetch(request: Request): Promise<Response> {
    if ((request.headers.get('Upgrade') ?? '').toLowerCase() !== 'websocket') {
      return new Response('expected websocket', { status: 426 })
    }
    if (this.ctx.getWebSockets().length >= ROOM_MAX_PEOPLE) {
      return new Response('room is full', { status: 429 })
    }
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    this.ctx.acceptWebSocket(server)
    const seat: Seat = { id: crypto.randomUUID(), joinedAt: Date.now() }
    server.serializeAttachment(seat)
    const lead = this.leadId()
    // A newcomer who is not the lead gets the lead's state at once. The
    // new lead of an empty room gets none: whatever is left in memory is
    // from a session that has ended.
    if (lead === seat.id) this.last = null
    this.send(server, {
      t: 'welcome',
      you: seat.id,
      lead,
      count: this.ctx.getWebSockets().length,
      state: this.last,
    })
    this.broadcastRoster()
    return new Response(null, { status: 101, webSocket: client })
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    const seat = socket.deserializeAttachment() as Seat | null
    if (!seat || seat.id !== this.leadId()) return
    const parsed = parseClientMessage(message)
    if (!parsed) return
    this.last = parsed.s
    const text = JSON.stringify({ t: 'state', s: parsed.s } satisfies RoomServerMessage)
    for (const other of this.ctx.getWebSockets()) {
      if (other === socket) continue
      try {
        other.send(text)
      } catch {
        // Closing; ignored as in `send`.
      }
    }
  }

  webSocketClose(socket: WebSocket, code: number): void {
    // The departing socket may still be listed while this runs.
    this.broadcastRoster(socket)
    try {
      socket.close(code === 1005 || code === 1006 ? 1000 : code)
    } catch {
      // Already closed.
    }
  }

  webSocketError(socket: WebSocket): void {
    this.broadcastRoster(socket)
  }
}

export default {
  /**
   * The site reaches rooms by binding, and this Worker has no public
   * address (`workers_dev = false`, no routes), so in production nothing
   * arrives here. Under `wrangler dev` it is the way in, at the same path
   * the site's route uses, for a dev server pointed at it with
   * `VITE_ROOM_WS_URL`.
   */
  fetch(request: Request, env: Env): Response | Promise<Response> {
    const match = /^\/api\/room\/([^/]+)$/.exec(new URL(request.url).pathname)
    const code = normalizeRoomCode(match?.[1])
    if (!code) return new Response('AYNI rooms', { status: 404 })
    return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(request)
  },
} satisfies ExportedHandler<Env>
