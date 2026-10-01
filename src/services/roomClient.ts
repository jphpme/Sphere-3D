// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * AYNI — this device's connection to a shared session's room
 * (`docs/SHARED_AR_PLAN.md`): one WebSocket, kept open, with the room's
 * messages turned into three facts — who leads, how many are here, and
 * the lead's latest state.
 *
 * It decides nothing about the sphere; `roomSync` does that. What it owns
 * is the socket's life: a dropped connection is retried with a growing
 * pause, because a phone in someone's hand changes networks and sleeps,
 * and a session should survive both. A reconnect is a new seat in the
 * room, so a lead that drops comes back as a follower; that is the room's
 * rule (the longest-connected leads), not something to work around here.
 *
 * `send` is a no-op unless this device is the lead. The room would drop
 * the message anyway; not sending it saves the phone the radio.
 */

import {
  normalizeRoomCode,
  parseServerMessage,
  type RoomClientMessage,
  type RoomState,
} from './roomProtocol'
import { logger } from '../utils/logger'

export interface RoomStatus {
  code: string
  connected: boolean
  /** Null until the room has said who leads. */
  role: 'lead' | 'follower' | null
  /** People in the room, this device included. */
  count: number
}

export interface RoomClientOptions {
  /** The lead's state arrived (never called on the lead itself). */
  onState: (state: RoomState) => void
  /** Connection, role or head-count changed. */
  onStatus: (status: RoomStatus) => void
  /** Where the room is; defaults to this site's own route. */
  url?: string
  /** Socket constructor, for tests. */
  createSocket?: (url: string) => WebSocket
}

export interface RoomClientHandle {
  status(): RoomStatus
  /** Send the lead's state. Ignored while not the lead or not connected. */
  send(state: RoomState): void
  close(): void
}

/** The room this page joined at boot, if any (see `joinedRoomCode`). */
let joinedCode: string | null = null

/**
 * The code of the room this page is in, or null. Read by the AR session
 * to decide whether to offer the marker scan: the address bar is not a
 * reliable place to look once the app has rewritten it for a dataset.
 */
export function joinedRoomCode(): string | null {
  return joinedCode
}

/** The room code in a page address (`?room=`), or null. */
export function roomCodeFromSearch(
  search: string = typeof window === 'undefined' ? '' : window.location.search,
): string | null {
  return normalizeRoomCode(new URLSearchParams(search).get('room'))
}

/** The room's WebSocket address for a code. */
export function roomSocketUrl(
  code: string,
  override: string | undefined = import.meta.env.VITE_ROOM_WS_URL as string | undefined,
  location: { protocol: string; host: string } = window.location,
): string {
  const base = override?.trim()
  if (base) return `${base.endsWith('/') ? base : `${base}/`}${code}`
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/room/${code}`
}

/** First retry after this long, doubling up to the cap. */
const RETRY_FIRST_MS = 1000
const RETRY_MAX_MS = 15000

export function connectRoom(code: string, opts: RoomClientOptions): RoomClientHandle {
  joinedCode = code
  const url = opts.url ?? roomSocketUrl(code)
  const createSocket = opts.createSocket ?? ((u: string) => new WebSocket(u))
  let socket: WebSocket | null = null
  let closed = false
  let retryMs = RETRY_FIRST_MS
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let myId: string | null = null
  const status: RoomStatus = { code, connected: false, role: null, count: 0 }

  const publish = (): void => opts.onStatus({ ...status })
  const setRoster = (lead: string | null, count: number): void => {
    status.role = myId === null || lead === null ? null : lead === myId ? 'lead' : 'follower'
    status.count = count
    publish()
  }

  function open(): void {
    if (closed) return
    let ws: WebSocket
    try {
      ws = createSocket(url)
    } catch (err) {
      logger.warn('[Room] could not open the socket:', err)
      scheduleRetry()
      return
    }
    socket = ws
    ws.addEventListener('open', () => {
      retryMs = RETRY_FIRST_MS
      status.connected = true
      publish()
    })
    ws.addEventListener('message', (ev: MessageEvent) => {
      const msg = parseServerMessage(ev.data)
      if (!msg) return
      if (msg.t === 'welcome') {
        myId = msg.you
        setRoster(msg.lead, msg.count)
        if (msg.state && status.role === 'follower') opts.onState(msg.state)
      } else if (msg.t === 'roster') {
        setRoster(msg.lead, msg.count)
      } else if (status.role !== 'lead') {
        opts.onState(msg.s)
      }
    })
    const onGone = (): void => {
      if (socket !== ws) return
      socket = null
      myId = null
      status.connected = false
      status.role = null
      publish()
      scheduleRetry()
    }
    ws.addEventListener('close', onGone)
    ws.addEventListener('error', () => {
      try { ws.close() } catch { /* already closing */ }
    })
  }

  function scheduleRetry(): void {
    if (closed || retryTimer !== null) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      open()
    }, retryMs)
    retryMs = Math.min(RETRY_MAX_MS, retryMs * 2)
  }

  open()

  return {
    status: () => ({ ...status }),
    send(state) {
      if (status.role !== 'lead' || !socket || socket.readyState !== 1) return
      const message: RoomClientMessage = { t: 'state', s: state }
      try {
        socket.send(JSON.stringify(message))
      } catch {
        // Closing; the close handler reconnects.
      }
    },
    close() {
      closed = true
      if (joinedCode === code) joinedCode = null
      if (retryTimer !== null) clearTimeout(retryTimer)
      retryTimer = null
      try { socket?.close() } catch { /* already closed */ }
      socket = null
    },
  }
}
