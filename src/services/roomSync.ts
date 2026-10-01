// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * AYNI — what a shared session does to this device
 * (`docs/SHARED_AR_PLAN.md`): the lead's sphere is described a few times
 * a second, and every follower makes its own sphere match.
 *
 * What travels: which dataset is on the sphere, where its playhead is,
 * the layers around it, where the browser globe's camera looks, and how
 * the sphere is turned and sized in AR. Each follower loads
 * the dataset and decodes the video itself; only the description crosses
 * the network, so a room costs a few hundred bytes a second however large
 * the stream is.
 *
 * The app is reached through `RoomSyncHost`, so this module knows nothing
 * of `main.ts` or the AR session, and the decisions with a wrong answer
 * available are pure functions:
 *
 *   - `shouldSend`: the lead speaks when something changed, or once a
 *     second regardless. A steadily playing video is not a change: a
 *     follower can predict it, so only a playhead that is not where the
 *     last message implies (a seek, a loop, a stall) is worth sending.
 *   - `followPlayback`: a follower closes a gap by playing a little
 *     faster or slower, and seeks only when it is seconds out. A seek
 *     stalls the decoder: the first version seeked at 0.6 s, and on a
 *     phone each seek cost more than that, so the follower fell behind
 *     again while seeking and the dataset played in jerks. A rate trim
 *     costs nothing and converges.
 *
 * A follower's own controls are not disabled; whatever it changes is put
 * back by the lead's next message. Passing the lead is the room's
 * business (`workers/rooms`): the longest-connected device leads.
 */

import { connectRoom, type RoomClientHandle, type RoomStatus } from './roomClient'
import type { RoomGlobe, RoomLayers, RoomPlayback, RoomState, RoomView } from './roomProtocol'

/** The app, as far as a shared session needs it. */
export interface RoomSyncHost {
  getDatasetId(): string | null
  loadDataset(id: string): void
  /** The primary dataset's video, when it has one. */
  getVideo(): HTMLVideoElement | null
  isPlaying(): boolean
  togglePlayPause(): void
  /** The sphere in the AR session; null outside one. */
  getGlobe(): RoomGlobe | null
  /** Make the AR sphere follow this pose; null hands it back to the user. */
  setFollowedGlobe(globe: RoomGlobe | null): void
  /** The browser globe's camera. */
  getView(): RoomView | null
  /** Move the browser globe's camera there. */
  setView(view: RoomView): void
  /** The layer stack around the dataset. */
  getLayers(): RoomLayers | null
  /** Put that layer stack on; a no-op when it already is. */
  setLayers(layers: RoomLayers): void
  /**
   * Take the browser globe out of this device's hands, or give it back.
   * Locked for the audience of a meeting while a presenter is leading:
   * there the globe is the presenter's to move.
   */
  setLocked(locked: boolean): void
}

/** How often the lead looks at its own state, ms. */
const LEAD_TICK_MS = 100
/** The lead repeats itself at least this often, changed or not. */
const HEARTBEAT_MS = 1000
/** How often a follower re-checks its playhead against the lead's. */
const FOLLOW_TICK_MS = 250
/** A playing follower within this of the lead is in step, seconds. */
export const IN_STEP_S = 0.1
/** A playing follower seeks only when further than this from the lead, and further than its seeks cost. */
export const SEEK_PLAYING_S = 2.5
/** What a seek is assumed to cost until one has been measured on this device, seconds. */
export const ASSUMED_SEEK_COST_S = 1
/** Between the two it trims its rate: by this much per second of gap… */
const TRIM_PER_SECOND = 0.2
/** …up to this fraction of the lead's rate, which the eye does not notice… */
export const MAX_RATE_TRIM = 0.1
/** …in steps of this much. */
const TRIM_STEP = 0.025
/** A follower at the lead's rate starts trimming only past this gap, seconds. */
const TRIM_START_S = 0.3
/** A paused follower holds the lead's frame to within this. */
const SEEK_PAUSED_S = 0.08
/** Within this of either end a video is left to its own loop: both devices rest on the last frame and start over by the same rule. */
const END_ZONE_S = 0.4
/** After a seek has landed, leave the decoder alone this long. */
const SEEK_SETTLE_MS = 3000
/** A dataset load is not asked for again within this. */
const LOAD_RETRY_MS = 10000

/** Where the lead's playhead is `elapsedS` after it sent `playback`. */
export function leadTime(playback: RoomPlayback, elapsedS: number): number {
  const time = playback.paused ? playback.time : playback.time + Math.max(0, elapsedS) * playback.rate
  // The end is held, not wrapped: the lead rests on its last frame before
  // looping, and says so with a fresh message when it starts over.
  return Math.min(playback.duration, time)
}

export interface PlaybackCorrection {
  /** Flip play/pause. */
  toggle: boolean
  /** Seek the local video here, seconds; null to leave it. */
  seekTo: number | null
  /** Set the local rate; null to leave it. */
  rate: number | null
}

/**
 * What a follower should do to its video to match the lead's. Positions
 * are compared as fractions of each device's own duration, because two
 * devices can pick renditions of slightly different length.
 *
 * Paused, the follower takes the lead's frame. Playing, it is in one of
 * three bands: in step (the lead's own rate), a gap the rate can close
 * (the lead's rate trimmed by up to MAX_RATE_TRIM, faster when behind and
 * slower when ahead), or further out (one seek). Near either end of the
 * video it does nothing: the loop is each device's own.
 *
 * `seekCostS` is how long a seek takes to land on this device, measured
 * by the caller. A seek is the expensive way to catch up — on a stream
 * near the limit of the connection it stalls the video for many seconds,
 * by which time the lead is far ahead again, and a follower that seeks
 * again loops for good — so the seek band starts above what a seek costs,
 * and a seek aims at where the lead will be once it has landed.
 *
 * Gaps are measured round the loop: every device loops the same video, so
 * a follower at the end and a lead just past the start are close.
 */
export function followPlayback(
  playback: RoomPlayback,
  elapsedS: number,
  local: { paused: boolean; time: number; duration: number; rate: number },
  seekCostS: number = ASSUMED_SEEK_COST_S,
): PlaybackCorrection {
  const target = (leadTime(playback, elapsedS) / playback.duration) * local.duration
  const toggle = playback.paused !== local.paused
  const setRate = (rate: number): number | null => (Math.abs(local.rate - rate) > 0.004 ? rate : null)
  const duration = local.duration
  const gap = playback.paused
    ? target - local.time
    : ((((target - local.time + duration / 2) % duration) + duration) % duration) - duration / 2
  if (playback.paused) {
    return {
      toggle,
      seekTo: Math.abs(gap) > SEEK_PAUSED_S ? Math.max(0, Math.min(local.duration, target)) : null,
      rate: setRate(playback.rate),
    }
  }
  const nearEnd = (time: number): boolean => time >= local.duration - END_ZONE_S
  if (nearEnd(target) || nearEnd(local.time)) return { toggle, seekTo: null, rate: setRate(playback.rate) }
  if (Math.abs(gap) <= IN_STEP_S) return { toggle, seekTo: null, rate: setRate(playback.rate) }
  if (Math.abs(gap) > Math.max(SEEK_PLAYING_S, 1.5 * seekCostS + 1)) {
    // Land where the lead will be by then, short of the end so the landing
    // is not straight into the loop.
    const aim = Math.min(duration - END_ZONE_S - 0.1, target + seekCostS * playback.rate)
    return { toggle, seekTo: Math.max(0, aim), rate: setRate(playback.rate) }
  }
  // A follower at the lead's own rate is left there until it is clearly
  // out (TRIM_START_S): every rate change is work for the decoder and the
  // audio path, and a gap that comes and goes is message jitter, not drift.
  const untrimmed = Math.abs(local.rate - playback.rate) <= 0.004
  if (untrimmed && Math.abs(gap) <= TRIM_START_S) return { toggle, seekTo: null, rate: null }
  // In steps, so a gap closing steadily changes the rate a few times, not on every tick.
  const raw = Math.max(-MAX_RATE_TRIM, Math.min(MAX_RATE_TRIM, gap * TRIM_PER_SECOND))
  const trim = Math.sign(raw) * Math.max(TRIM_STEP, Math.round(Math.abs(raw) / TRIM_STEP) * TRIM_STEP)
  const rate = playback.rate * (1 + trim)
  return { toggle, seekTo: null, rate: Math.abs(local.rate - rate) > 0.004 ? rate : null }
}

/**
 * Do two cameras differ by more than a still globe's jitter? Longitude
 * is compared the short way round, and more finely the closer the camera
 * is, since a hundredth of a degree is nothing from orbit and a street
 * from zoom 14.
 */
export function viewsDiffer(a: RoomView, b: RoomView): boolean {
  const fine = 0.5 / 2 ** Math.max(0, Math.min(a.zoom, b.zoom))
  const turn = Math.abs(((((a.lon - b.lon + 180) % 360) + 360) % 360) - 180)
  return (
    Math.abs(a.lat - b.lat) > fine ||
    turn > fine ||
    Math.abs(a.zoom - b.zoom) > 0.01 ||
    Math.abs(((((a.bearing - b.bearing + 180) % 360) + 360) % 360) - 180) > 0.2 ||
    Math.abs(a.pitch - b.pitch) > 0.2
  )
}

/** The angle between two orientations, radians. */
function turnBetween(a: readonly number[], b: readonly number[]): number {
  const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])
  return 2 * Math.acos(Math.min(1, dot))
}

/**
 * Is `next` worth sending, given what was sent `elapsedMs` ago? Yes when
 * a follower could not have predicted it from `prev`, or when the
 * heartbeat is due.
 */
export function shouldSend(prev: RoomState | null, next: RoomState, elapsedMs: number): boolean {
  if (!prev || elapsedMs >= HEARTBEAT_MS) return true
  if (prev.datasetId !== next.datasetId) return true
  if ((prev.playback === null) !== (next.playback === null)) return true
  if (prev.playback && next.playback) {
    if (prev.playback.paused !== next.playback.paused) return true
    if (Math.abs(prev.playback.rate - next.playback.rate) > 0.001) return true
    if (Math.abs(leadTime(prev.playback, elapsedMs / 1000) - next.playback.time) > 0.25) return true
  }
  if ((prev.globe === null) !== (next.globe === null)) return true
  if ((prev.view === null) !== (next.view === null)) return true
  if (prev.view && next.view && viewsDiffer(prev.view, next.view)) return true
  if (JSON.stringify(prev.layers) !== JSON.stringify(next.layers)) return true
  if (prev.globe && next.globe) {
    if (prev.globe.aligned !== next.globe.aligned) return true
    if (Math.abs(prev.globe.scale - next.globe.scale) > 0.005 * prev.globe.scale) return true
    if (turnBetween(prev.globe.q, next.globe.q) > 0.005) return true
  }
  return false
}

export interface RoomSyncHandle {
  status(): RoomStatus
  /** This device's own state right now, as a lead would report it. */
  snapshot(): RoomState
  /** Called now with the current status, and on every change. Returns an unsubscribe. */
  onStatus(listener: (status: RoomStatus) => void): () => void
  stop(): void
}

export interface RoomSyncOptions {
  /** Clock, for tests. */
  nowMs?: () => number
  /** Build the connection, for tests. */
  connect?: typeof connectRoom
  /** The signed link's token, when the page was opened from one. */
  token?: string | null
}

let current: RoomSyncHandle | null = null

/** The running shared session, if this page is in one. */
export function activeRoomSync(): RoomSyncHandle | null {
  return current
}

/** Join room `code` and keep this device in step with it. */
export function startRoomSync(code: string, host: RoomSyncHost, opts: RoomSyncOptions = {}): RoomSyncHandle {
  current?.stop()
  const nowMs = opts.nowMs ?? (() => performance.now())
  const listeners = new Set<(status: RoomStatus) => void>()
  let status: RoomStatus = { code, connected: false, role: null, count: 0, meeting: false, seat: null, hasLead: false }

  // --- follower side ---
  let followed: { state: RoomState; at: number } | null = null
  let lastSeekAt = -Infinity
  let loadAsked: { id: string; at: number } | null = null
  /** How long seeks take to land on this device, from the last one measured. */
  let seekCostS = ASSUMED_SEEK_COST_S
  /** A seek in flight: when it was issued. */
  let seekIssuedAt: number | null = null
  /** The lead's own rate, to put back when this device stops following: a trimmed rate is not this video's rate. */
  let untrimmedRate: number | null = null

  function restoreRate(): void {
    const video = host.getVideo()
    if (video && untrimmedRate !== null) video.playbackRate = untrimmedRate
    untrimmedRate = null
  }

  function follow(): void {
    if (status.role !== 'follower' || !followed) return
    const { state, at } = followed
    const now = nowMs()
    if (state.datasetId && state.datasetId !== host.getDatasetId()) {
      if (!loadAsked || loadAsked.id !== state.datasetId || now - loadAsked.at > LOAD_RETRY_MS) {
        loadAsked = { id: state.datasetId, at: now }
        host.loadDataset(state.datasetId)
      }
      return // nothing to steer until the same dataset is on the sphere
    }
    // The same dataset is up: its surroundings next. (The host makes
    // this a no-op once they match, so the tick may ask every time.)
    if (state.layers) host.setLayers(state.layers)
    const video = host.getVideo()
    if (!state.playback || !video || !(video.duration > 0) || video.readyState < 2) return
    const playing = host.isPlaying()
    // A video that is mid-seek, still buffering, or not advancing though
    // the app has it playing (resting on its last frame between loops, or
    // held by the browser until the page is tapped) has no position worth
    // correcting. Steering it would be a seek every few seconds on a
    // picture that is not moving: a slideshow.
    const advancing = !video.seeking && video.readyState >= 3 && !(playing && video.paused)
    if (seekIssuedAt !== null && advancing) {
      // A seek is over once the video plays on from it: now its cost is
      // known, and it is known before the next decision is made with it.
      seekCostS = Math.max(0.3, (now - seekIssuedAt) / 1000)
      seekIssuedAt = null
      lastSeekAt = now
    }
    const fix = followPlayback(
      state.playback,
      (now - at) / 1000,
      { paused: !playing, time: video.currentTime, duration: video.duration, rate: video.playbackRate },
      seekCostS,
    )
    if (fix.toggle) host.togglePlayPause()
    // Not while a seek is still landing, nor on a video that is not moving.
    if (seekIssuedAt !== null) return
    if (!state.playback.paused && !advancing) return
    if (fix.rate !== null) {
      untrimmedRate = state.playback.rate
      video.playbackRate = fix.rate
    }
    if (fix.seekTo !== null && !video.seeking && now - lastSeekAt > SEEK_SETTLE_MS) {
      lastSeekAt = now
      // A paused video lands at once; only a playing one has a cost to learn.
      if (!state.playback.paused) seekIssuedAt = now
      video.currentTime = fix.seekTo
    }
  }

  // --- lead side ---
  let sent: { state: RoomState; at: number } | null = null

  function readState(): RoomState {
    const video = host.getVideo()
    const playback: RoomPlayback | null =
      video && video.duration > 0 && Number.isFinite(video.duration)
        ? {
            paused: !host.isPlaying(),
            time: Math.max(0, Math.min(video.duration, video.currentTime)),
            duration: video.duration,
            rate: video.playbackRate > 0 ? video.playbackRate : 1,
          }
        : null
    return {
      datasetId: host.getDatasetId(),
      playback,
      globe: host.getGlobe(),
      view: host.getView(),
      layers: host.getLayers(),
    }
  }

  function lead(): void {
    if (status.role !== 'lead') return
    const now = nowMs()
    const state = readState()
    if (!shouldSend(sent?.state ?? null, state, sent ? now - sent.at : Infinity)) return
    sent = { state, at: now }
    client.send(state)
  }

  const client: RoomClientHandle = (opts.connect ?? connectRoom)(code, {
    token: opts.token ?? null,
    onState: (state) => {
      followed = { state, at: nowMs() }
      host.setFollowedGlobe(state.globe)
      // The camera is moved when the lead says where it is, not on the
      // follower's own tick: between messages the follower's globe is
      // still, and re-applying a stale view would fight nothing.
      const local = host.getView()
      if (state.view && (!local || viewsDiffer(local, state.view))) host.setView(state.view)
      follow()
    },
    onStatus: (next) => {
      const was = status.role
      status = next
      if (next.role !== 'follower') {
        // Leading, or cut off: the sphere is this device's own again.
        followed = null
        host.setFollowedGlobe(null)
        restoreRate()
      }
      // A device that has just become the lead says where things stand at once.
      if (next.role === 'lead' && was !== 'lead') sent = null
      host.setLocked(next.meeting && next.role === 'follower')
      for (const listener of listeners) listener({ ...status })
    },
  })

  const leadTimer = setInterval(lead, LEAD_TICK_MS)
  const followTimer = setInterval(follow, FOLLOW_TICK_MS)

  const handle: RoomSyncHandle = {
    status: () => ({ ...status }),
    snapshot: readState,
    onStatus(listener) {
      listeners.add(listener)
      listener({ ...status })
      return () => listeners.delete(listener)
    },
    stop() {
      clearInterval(leadTimer)
      clearInterval(followTimer)
      client.close()
      host.setFollowedGlobe(null)
      host.setLocked(false)
      restoreRate()
      listeners.clear()
      if (current === handle) current = null
    },
  }
  current = handle
  return handle
}
