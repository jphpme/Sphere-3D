// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * AYNI — the room of a shared session (`docs/SHARED_AR_PLAN.md`): one
 * Durable Object per room code, relaying the lead's state to everyone
 * else over WebSockets.
 *
 * A separate Worker because a Pages project cannot define a Durable
 * Object class; the site reaches it through the `ROOMS` binding
 * (`functions/api/room/[code].ts`, `functions/api/meeting/index.ts`).
 * Deployed by hand, not by CI:
 *
 *   npx wrangler deploy --config workers/rooms/wrangler.toml
 *
 * A room is one of two kinds, and the rules of each are enforced here
 * rather than trusted to the browser:
 *
 *   - an open room, which exists the moment anyone opens its code. The
 *     lead is whoever has been connected longest; when it leaves, the
 *     next longest takes over. At most ROOM_MAX_PEOPLE.
 *   - a meeting, which exists only once the site has declared it
 *     (`POST /init`, sent by the meeting route after it has checked who
 *     is asking). Only a presenter leads; with no presenter connected
 *     nobody does, and the room waits. At most MEETING_MAX_PEOPLE, until
 *     the meeting's end, when the room forgets it was one.
 *
 * Who a connection is — presenter, moderator or audience — is not for the
 * connection to say. It arrives in the `X-Room-Role` header, which the
 * site's route sets after checking a signed link, and which this Worker
 * can trust because nothing else can reach it: it has no public address.
 *
 * In both kinds only the lead's messages are relayed, and only if they
 * parse as a state (`roomProtocol.ts`). The latest state is kept in
 * memory for people arriving mid-session, and the lead repeats it every
 * second, so a room that was evicted is whole again within one beat.
 * Sockets use the hibernation API, with each connection's seat in its
 * attachment, so who leads survives an eviction too. The one thing
 * stored is that the room is a meeting, and until when.
 */

import { DurableObject } from 'cloudflare:workers'
import {
  MEETING_MAX_PEOPLE,
  ROOM_MAX_PEOPLE,
  normalizeRoomCode,
  parseClientMessage,
  parseRoomSeat,
  type RoomSeat,
  type RoomServerMessage,
  type RoomState,
} from '../../../src/services/roomProtocol'

export interface Env {
  ROOMS: DurableObjectNamespace<Room>
}

interface Seat {
  id: string
  joinedAt: number
  seat: RoomSeat
}

/** Header carrying a connection's seat, set by the site's route. */
const ROLE_HEADER = 'X-Room-Role'
/** Header carrying a meeting's end, epoch ms, on `POST /init`. */
const MEETING_UNTIL_HEADER = 'X-Meeting-Until'
/** Longest a meeting may be declared for. */
const MEETING_MAX_MS = 24 * 60 * 60 * 1000

export class Room extends DurableObject<Env> {
  /** The lead's latest state; lost on eviction, restored by the lead's next beat. */
  private last: RoomState | null = null
  /** When this room stops being a meeting, epoch ms; null for an open room. */
  private meetingUntil: number | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    void ctx.blockConcurrencyWhile(async () => {
      const until = await ctx.storage.get<number>('meetingUntil')
      this.meetingUntil = typeof until === 'number' ? until : null
    })
  }

  private isMeeting(): boolean {
    return this.meetingUntil !== null && Date.now() < this.meetingUntil
  }

  private seats(without?: WebSocket): { socket: WebSocket; seat: Seat }[] {
    const seats: { socket: WebSocket; seat: Seat }[] = []
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === without) continue
      const seat = socket.deserializeAttachment() as Seat | null
      if (seat) seats.push({ socket, seat })
    }
    return seats
  }

  /**
   * Who leads: in a meeting the longest-connected presenter and nobody
   * else; in an open room the longest-connected participant.
   */
  private leadId(without?: WebSocket): string | null {
    const meeting = this.isMeeting()
    let lead: Seat | null = null
    for (const { seat } of this.seats(without)) {
      if (meeting && seat.seat !== 'presenter') continue
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
    const seats = this.seats(without)
    const text = JSON.stringify({
      t: 'roster',
      lead: this.leadId(without),
      count: seats.length,
      meeting: this.isMeeting(),
    } satisfies RoomServerMessage)
    for (const { socket } of seats) {
      try {
        socket.send(text)
      } catch {
        // Closing; ignored as in `send`.
      }
    }
  }

  /** `POST /init`: the site declares this room a meeting until the given time. */
  private async declareMeeting(request: Request): Promise<Response> {
    const until = Number(request.headers.get(MEETING_UNTIL_HEADER))
    const now = Date.now()
    if (!Number.isFinite(until) || until <= now || until > now + MEETING_MAX_MS) {
      return new Response('bad meeting end', { status: 400 })
    }
    // Persist first, then remember (and let the alarm forget it).
    await this.ctx.storage.put('meetingUntil', until)
    await this.ctx.storage.setAlarm(until)
    this.meetingUntil = until
    this.last = null
    this.broadcastRoster()
    return new Response(null, { status: 204 })
  }

  /** The meeting's end: the room is an open room again, with nothing stored. */
  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll()
    this.meetingUntil = null
    this.last = null
    this.broadcastRoster()
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname.endsWith('/init')) return this.declareMeeting(request)
    if ((request.headers.get('Upgrade') ?? '').toLowerCase() !== 'websocket') {
      return new Response('expected websocket', { status: 426 })
    }
    const meeting = this.isMeeting()
    if (this.ctx.getWebSockets().length >= (meeting ? MEETING_MAX_PEOPLE : ROOM_MAX_PEOPLE)) {
      return new Response('room is full', { status: 429 })
    }
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    this.ctx.acceptWebSocket(server)
    const seat: Seat = {
      id: crypto.randomUUID(),
      joinedAt: Date.now(),
      // A seat means something only in a meeting.
      seat: meeting ? (parseRoomSeat(request.headers.get(ROLE_HEADER)) ?? 'audience') : 'audience',
    }
    server.serializeAttachment(seat)
    const lead = this.leadId()
    // A newcomer who is not the lead gets the lead's state at once. A new
    // lead gets none: whatever is left in memory is from a lead who has gone.
    if (lead === seat.id) this.last = null
    this.send(server, {
      t: 'welcome',
      you: seat.id,
      lead,
      count: this.ctx.getWebSockets().length,
      state: lead === null ? null : this.last,
      meeting,
      seat: meeting ? seat.seat : null,
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
   * arrives here. Under `wrangler dev` it is the way in, standing in for
   * the site's two routes with their checks left out, for a dev server
   * pointed at it with `VITE_ROOM_WS_URL`:
   *
   *   POST /api/meeting-dev/:code          declare a one-hour meeting
   *   GET  /api/room/:code?st=dev.<seat>   join, in the seat named
   */
  fetch(request: Request, env: Env): Response | Promise<Response> {
    const url = new URL(request.url)
    const declared = /^\/api\/meeting-dev\/([^/]+)$/.exec(url.pathname)
    const declaredCode = normalizeRoomCode(declared?.[1])
    if (declaredCode && request.method === 'POST') {
      return env.ROOMS.get(env.ROOMS.idFromName(declaredCode)).fetch(
        new Request('https://room/init', {
          method: 'POST',
          headers: { [MEETING_UNTIL_HEADER]: String(Date.now() + 60 * 60 * 1000) },
        }),
      )
    }
    const match = /^\/api\/room\/([^/]+)$/.exec(url.pathname)
    const code = normalizeRoomCode(match?.[1])
    if (!code) return new Response('AYNI rooms', { status: 404 })
    const headers = new Headers(request.headers)
    headers.delete(ROLE_HEADER)
    const devSeat = parseRoomSeat((url.searchParams.get('st') ?? '').replace(/^dev\./, ''))
    if (devSeat) headers.set(ROLE_HEADER, devSeat)
    return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(new Request(request, { headers }))
  },
} satisfies ExportedHandler<Env>
