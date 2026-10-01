// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import {
  ROOM_MAX_MESSAGE_CHARS,
  newRoomCode,
  normalizeRoomCode,
  parseClientMessage,
  parseRoomState,
  parseServerMessage,
  type RoomState,
} from './roomProtocol'

const state: RoomState = {
  datasetId: 'DS_1',
  playback: { paused: false, time: 12.5, duration: 120, rate: 1 },
  globe: { q: [0, 0, 0, 1], scale: 1.2, aligned: true },
}

describe('room codes', () => {
  it('accepts a code however it was typed, and nothing else', () => {
    expect(normalizeRoomCode(' ab12cd ')).toBe('AB12CD')
    expect(normalizeRoomCode('abc')).toBeNull()
    expect(normalizeRoomCode('AB-12')).toBeNull()
    expect(normalizeRoomCode('../../etc')).toBeNull()
    expect(normalizeRoomCode(null)).toBeNull()
  })

  it('mints six characters that are themselves valid, without look-alikes', () => {
    let n = 0
    const code = newRoomCode(() => (n++ % 32) / 32)
    expect(code).toHaveLength(6)
    expect(normalizeRoomCode(code)).toBe(code)
    for (let i = 0; i < 200; i++) expect(newRoomCode()).not.toMatch(/[IO01]/)
  })
})

describe('parseRoomState', () => {
  it('passes a whole state through', () => {
    expect(parseRoomState(JSON.parse(JSON.stringify(state)))).toEqual(state)
  })

  it('allows the bare Earth: no dataset, no playback, no sphere', () => {
    expect(parseRoomState({ datasetId: null, playback: null, globe: null })).toEqual({
      datasetId: null,
      playback: null,
      globe: null,
    })
  })

  it('brings a slightly off quaternion back to unit length', () => {
    const parsed = parseRoomState({ ...state, globe: { q: [0, 0, 0, 1.05], scale: 1, aligned: false } })
    expect(parsed?.globe?.q).toEqual([0, 0, 0, 1])
  })

  it.each([
    ['a dataset id that is not a string', { ...state, datasetId: 7 }],
    ['an empty dataset id', { ...state, datasetId: '' }],
    ['a playhead that is not a number', { ...state, playback: { ...state.playback, time: 'now' } }],
    ['a NaN duration', { ...state, playback: { ...state.playback, duration: NaN } }],
    ['a zero duration', { ...state, playback: { ...state.playback, duration: 0 } }],
    ['an absurd rate', { ...state, playback: { ...state.playback, rate: 400 } }],
    ['a quaternion of three numbers', { ...state, globe: { ...state.globe, q: [0, 0, 1] } }],
    ['a quaternion that is no rotation', { ...state, globe: { ...state.globe, q: [0, 0, 0, 0] } }],
    ['a negative scale', { ...state, globe: { ...state.globe, scale: -1 } }],
    ['a string', 'state'],
    ['null', null],
  ])('refuses %s', (_name, raw) => {
    expect(parseRoomState(raw)).toBeNull()
  })
})

describe('messages', () => {
  it('reads a state from a browser', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'state', s: state }))).toEqual({ t: 'state', s: state })
  })

  it('refuses anything else from a browser', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'welcome', you: 'x', lead: 'x', count: 1 }))).toBeNull()
    expect(parseClientMessage('not json')).toBeNull()
    expect(parseClientMessage(new ArrayBuffer(4))).toBeNull()
    expect(parseClientMessage(JSON.stringify({ t: 'state', s: { ...state, datasetId: 'x'.repeat(ROOM_MAX_MESSAGE_CHARS) } }))).toBeNull()
  })

  it('reads the room’s three messages', () => {
    expect(parseServerMessage(JSON.stringify({ t: 'welcome', you: 'a', lead: 'b', count: 2, state }))).toEqual({
      t: 'welcome', you: 'a', lead: 'b', count: 2, state,
    })
    expect(parseServerMessage(JSON.stringify({ t: 'welcome', you: 'a', lead: 'a', count: 1, state: null }))).toEqual({
      t: 'welcome', you: 'a', lead: 'a', count: 1, state: null,
    })
    expect(parseServerMessage(JSON.stringify({ t: 'roster', lead: null, count: 0 }))).toEqual({
      t: 'roster', lead: null, count: 0,
    })
    expect(parseServerMessage(JSON.stringify({ t: 'state', s: state }))).toEqual({ t: 'state', s: state })
  })

  it('refuses a malformed message from the room', () => {
    expect(parseServerMessage(JSON.stringify({ t: 'roster', lead: 5, count: 1 }))).toBeNull()
    expect(parseServerMessage(JSON.stringify({ t: 'welcome', lead: 'a', count: 1 }))).toBeNull()
    expect(parseServerMessage(JSON.stringify({ t: 'shout' }))).toBeNull()
  })
})
