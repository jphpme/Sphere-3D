// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * AYNI — the wire contract of a shared session (`docs/SHARED_AR_PLAN.md`):
 * what one device tells the others so that everyone sees the same sphere
 * doing the same thing.
 *
 * One device leads and the rest follow. In an open room the lead is the
 * participant who has been there longest; when it leaves, the next
 * longest takes over. In a meeting only a presenter leads, and each
 * connection has a seat (presenter, moderator, audience) that the site
 * assigns from a signed link. Only the lead's state is relayed.
 *
 * Imported by the browser (`roomClient`, `roomSync`), by the room's
 * Durable Object (`workers/rooms`) and by the Pages route in front of it,
 * so it is names, shapes and validation only: no DOM, no Worker globals.
 * Everything that arrives over the socket is checked here, field by
 * field, before either side acts on it — a room is open to anyone with
 * its code.
 */

/** What the lead's sphere is showing. */
export interface RoomState {
  /** The dataset on the sphere, or null for the bare Earth. */
  datasetId: string | null
  /** The playhead of a video dataset; null for a picture or no dataset. */
  playback: RoomPlayback | null
  /** The sphere in AR; null while the lead is not in an AR session. */
  globe: RoomGlobe | null
  /** The browser globe's camera; null when the lead has none to report. */
  view: RoomView | null
  /** The layer stack around the dataset; null when the lead reports none. */
  layers: RoomLayers | null
}

/** Where the browser globe's camera looks, in MapLibre's own terms. */
export interface RoomView {
  lat: number
  /** Degrees east, -180 to 180. */
  lon: number
  zoom: number
  bearing: number
  pitch: number
}

/** The basemap under the dataset, the overlays above it, and the real-time overlay stream. */
export interface RoomLayers {
  basemapId: string | null
  overlays: { id: string; tint: 'source' | 'white' | 'black' }[]
  /** The dataset id of the real-time overlay playing over the dataset, or null. */
  rt: string | null
}

/** Most overlays a state may name. */
export const ROOM_MAX_OVERLAYS = 8

export interface RoomPlayback {
  paused: boolean
  /** Seconds into the video when this state was sent. */
  time: number
  /** The video's length in seconds on the lead's device. */
  duration: number
  rate: number
}

export interface RoomGlobe {
  /**
   * The sphere's orientation as a quaternion [x, y, z, w]: in the
   * marker's frame when `aligned`, else in the lead's own session space.
   */
  q: [number, number, number, number]
  scale: number
  /** Whether the lead placed the sphere from the shared marker. */
  aligned: boolean
}

/** A connection's seat in a meeting. */
export type RoomSeat = 'presenter' | 'moderator' | 'audience'

/** A seat as named on the wire, or null. */
export function parseRoomSeat(raw: unknown): RoomSeat | null {
  return raw === 'presenter' || raw === 'moderator' || raw === 'audience' ? raw : null
}

/** Browser → room. */
export type RoomClientMessage = { t: 'state'; s: RoomState }

/** Room → browser. */
export type RoomServerMessage =
  | {
      t: 'welcome'
      /** This connection's id. */
      you: string
      /** The lead's id. */
      lead: string | null
      /** People in the room, this one included. */
      count: number
      /** The lead's latest state, for someone arriving mid-session. */
      state: RoomState | null
      /** Whether the room is a meeting. */
      meeting: boolean
      /** This connection's seat in a meeting; null in an open room. */
      seat: RoomSeat | null
    }
  | { t: 'roster'; lead: string | null; count: number; meeting: boolean }
  | { t: 'state'; s: RoomState }

/** Largest message either side accepts, in characters. */
export const ROOM_MAX_MESSAGE_CHARS = 2048
/** Most people in one open room. */
export const ROOM_MAX_PEOPLE = 40
/** Most people in one meeting. */
export const MEETING_MAX_PEOPLE = 500

/** Room codes: letters and digits that are hard to misread aloud or on paper. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_PATTERN = /^[A-Z0-9]{4,12}$/

/** A code as typed or scanned, made canonical; null when it is not one. */
export function normalizeRoomCode(raw: string | null | undefined): string | null {
  const code = (raw ?? '').trim().toUpperCase()
  return CODE_PATTERN.test(code) ? code : null
}

/** A fresh six-character code. `random` returns values in [0, 1). */
export function newRoomCode(random: () => number = Math.random): string {
  let code = ''
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)]
  return code
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** A state as received, or null when any part of it is not what it claims. */
export function parseRoomState(raw: unknown): RoomState | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const datasetId = r.datasetId
  if (datasetId !== null && (typeof datasetId !== 'string' || datasetId.length === 0 || datasetId.length > 200)) {
    return null
  }
  let playback: RoomPlayback | null = null
  if (r.playback !== null && r.playback !== undefined) {
    const p = r.playback as Record<string, unknown>
    if (typeof r.playback !== 'object' || typeof p.paused !== 'boolean') return null
    if (!finite(p.time) || !finite(p.duration) || !finite(p.rate)) return null
    if (p.time < 0 || p.duration <= 0 || p.rate <= 0 || p.rate > 16) return null
    playback = { paused: p.paused, time: p.time, duration: p.duration, rate: p.rate }
  }
  let globe: RoomGlobe | null = null
  if (r.globe !== null && r.globe !== undefined) {
    const g = r.globe as Record<string, unknown>
    if (typeof r.globe !== 'object' || typeof g.aligned !== 'boolean') return null
    if (!finite(g.scale) || g.scale <= 0 || g.scale > 100) return null
    const q = g.q
    if (!Array.isArray(q) || q.length !== 4 || !q.every(finite)) return null
    const [x, y, z, w] = q as number[]
    const norm = Math.hypot(x, y, z, w)
    // A rotation is a unit quaternion; anything far from one is not a pose.
    if (norm < 0.9 || norm > 1.1) return null
    globe = { q: [x / norm, y / norm, z / norm, w / norm], scale: g.scale, aligned: g.aligned }
  }
  let view: RoomView | null = null
  if (r.view !== null && r.view !== undefined) {
    const v = r.view as Record<string, unknown>
    if (typeof r.view !== 'object') return null
    if (!finite(v.lat) || !finite(v.lon) || !finite(v.zoom) || !finite(v.bearing) || !finite(v.pitch)) return null
    if (Math.abs(v.lat) > 90 || v.zoom < -4 || v.zoom > 30 || v.pitch < 0 || v.pitch > 90) return null
    // Longitude and bearing are angles: any turn count means the same place.
    const wrap = (deg: number): number => ((((deg + 180) % 360) + 360) % 360) - 180
    view = { lat: v.lat, lon: wrap(v.lon), zoom: v.zoom, bearing: wrap(v.bearing), pitch: v.pitch }
  }
  let layers: RoomLayers | null = null
  if (r.layers !== null && r.layers !== undefined) {
    const l = r.layers as Record<string, unknown>
    if (typeof r.layers !== 'object') return null
    const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200
    if (l.basemapId !== null && !id(l.basemapId)) return null
    if (l.rt !== null && !id(l.rt)) return null
    if (!Array.isArray(l.overlays) || l.overlays.length > ROOM_MAX_OVERLAYS) return null
    const overlays: RoomLayers['overlays'] = []
    for (const raw of l.overlays as unknown[]) {
      const o = raw as Record<string, unknown> | null
      if (typeof o !== 'object' || o === null || !id(o.id)) return null
      if (o.tint !== 'source' && o.tint !== 'white' && o.tint !== 'black') return null
      overlays.push({ id: o.id, tint: o.tint })
    }
    layers = { basemapId: l.basemapId, overlays, rt: l.rt }
  }
  return { datasetId, playback, globe, view, layers }
}

function parseJson(text: unknown): Record<string, unknown> | null {
  if (typeof text !== 'string' || text.length > ROOM_MAX_MESSAGE_CHARS) return null
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** What a browser sent, or null. */
export function parseClientMessage(text: unknown): RoomClientMessage | null {
  const msg = parseJson(text)
  if (!msg || msg.t !== 'state') return null
  const s = parseRoomState(msg.s)
  return s ? { t: 'state', s } : null
}

const idOrNull = (v: unknown): v is string | null =>
  v === null || (typeof v === 'string' && v.length > 0 && v.length <= 64)

/** What the room sent, or null. */
export function parseServerMessage(text: unknown): RoomServerMessage | null {
  const msg = parseJson(text)
  if (!msg) return null
  if (msg.t === 'state') {
    const s = parseRoomState(msg.s)
    return s ? { t: 'state', s } : null
  }
  if (msg.t !== 'welcome' && msg.t !== 'roster') return null
  if (!idOrNull(msg.lead) || !finite(msg.count) || msg.count < 0) return null
  // Absent on a room from before meetings existed: an open room.
  const meeting = msg.meeting === true
  if (msg.t === 'roster') return { t: 'roster', lead: msg.lead, count: msg.count, meeting }
  if (typeof msg.you !== 'string' || msg.you.length === 0 || msg.you.length > 64) return null
  const state = msg.state === null || msg.state === undefined ? null : parseRoomState(msg.state)
  return {
    t: 'welcome',
    you: msg.you,
    lead: msg.lead,
    count: msg.count,
    state,
    meeting,
    seat: meeting ? (parseRoomSeat(msg.seat) ?? 'audience') : null,
  }
}
