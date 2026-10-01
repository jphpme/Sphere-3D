// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectRoom, joinedRoomCode, roomCodeFromSearch, roomSocketUrl, type RoomStatus } from './roomClient'
import type { RoomState } from './roomProtocol'

/** A socket the test drives from the room's side. */
class FakeSocket extends EventTarget {
  readyState = 0
  sent: string[] = []
  constructor(readonly url: string) {
    super()
  }
  send(text: string): void {
    this.sent.push(text)
  }
  close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.dispatchEvent(new Event('close'))
  }
  open(): void {
    this.readyState = 1
    this.dispatchEvent(new Event('open'))
  }
  receive(message: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }))
  }
}

const state: RoomState = { datasetId: 'DS_1', playback: null, globe: null, view: null, layers: null }

describe('room addresses', () => {
  it('reads the code from the page address', () => {
    expect(roomCodeFromSearch('?room=ab12cd')).toBe('AB12CD')
    expect(roomCodeFromSearch('?room=no')).toBeNull()
    expect(roomCodeFromSearch('')).toBeNull()
  })

  it('points at this site’s own route, secure when the page is', () => {
    expect(roomSocketUrl('AB12CD', undefined, { protocol: 'https:', host: 'vr.example' })).toBe('wss://vr.example/api/room/AB12CD')
    expect(roomSocketUrl('AB12CD', undefined, { protocol: 'http:', host: 'localhost:5173' })).toBe('ws://localhost:5173/api/room/AB12CD')
    expect(roomSocketUrl('AB12CD', 'ws://127.0.0.1:8797/api/room', { protocol: 'http:', host: 'x' })).toBe('ws://127.0.0.1:8797/api/room/AB12CD')
  })
})

describe('connectRoom', () => {
  let sockets: FakeSocket[]
  let statuses: RoomStatus[]
  let states: RoomState[]

  beforeEach(() => {
    vi.useFakeTimers()
    sockets = []
    statuses = []
    states = []
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const connect = () =>
    connectRoom('AB12CD', {
      url: 'ws://room.test/AB12CD',
      onState: (s) => states.push(s),
      onStatus: (s) => statuses.push(s),
      createSocket: (url) => {
        const socket = new FakeSocket(url)
        sockets.push(socket)
        return socket as unknown as WebSocket
      },
    })

  it('learns its role from the room and counts the people in it', () => {
    const room = connect()
    expect(joinedRoomCode()).toBe('AB12CD')
    sockets[0].open()
    sockets[0].receive({ t: 'welcome', you: 'me', lead: 'me', count: 1, state: null })
    expect(room.status()).toEqual({ code: 'AB12CD', connected: true, role: 'lead', count: 1 })
    sockets[0].receive({ t: 'roster', lead: 'other', count: 2 })
    expect(room.status().role).toBe('follower')
    room.close()
    expect(joinedRoomCode()).toBeNull()
  })

  it('sends only as the lead', () => {
    const room = connect()
    sockets[0].open()
    sockets[0].receive({ t: 'welcome', you: 'me', lead: 'other', count: 2, state: null })
    room.send(state)
    expect(sockets[0].sent).toHaveLength(0)
    sockets[0].receive({ t: 'roster', lead: 'me', count: 1 })
    room.send(state)
    expect(JSON.parse(sockets[0].sent[0])).toEqual({ t: 'state', s: state })
    room.close()
  })

  it('hands a follower the state it arrived to, and every one after', () => {
    const room = connect()
    sockets[0].open()
    sockets[0].receive({ t: 'welcome', you: 'me', lead: 'other', count: 2, state })
    sockets[0].receive({ t: 'state', s: { ...state, datasetId: 'DS_2' } })
    sockets[0].receive({ t: 'state', s: { datasetId: 5 } }) // malformed: dropped
    expect(states.map((s) => s.datasetId)).toEqual(['DS_1', 'DS_2'])
    room.close()
  })

  it('reconnects after a drop, with a growing pause, as a new arrival', () => {
    const room = connect()
    sockets[0].open()
    sockets[0].receive({ t: 'welcome', you: 'me', lead: 'me', count: 1, state: null })
    sockets[0].close()
    expect(room.status()).toMatchObject({ connected: false, role: null })
    vi.advanceTimersByTime(999)
    expect(sockets).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(sockets).toHaveLength(2)
    sockets[1].close() // refused again: the next pause is twice as long
    vi.advanceTimersByTime(1999)
    expect(sockets).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(sockets).toHaveLength(3)
    room.close()
  })

  it('stays closed once closed', () => {
    const room = connect()
    sockets[0].open()
    room.close()
    vi.advanceTimersByTime(60000)
    expect(sockets).toHaveLength(1)
  })
})
