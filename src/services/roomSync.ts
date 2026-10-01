// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * AYNI — what a shared session does to this device
 * (`docs/SHARED_AR_PLAN.md`): the lead's sphere is described a few times
 * a second, and every follower makes its own sphere match.
 *
 * Three things travel: which dataset is on the sphere, where its playhead
 * is, and how the sphere is turned and sized in AR. Each follower loads
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
 *   - `followPlayback`: a follower seeks only when it is clearly out of
 *     step. A seek stalls the decoder, so chasing small errors would
 *     manufacture the stutter it is trying to remove.
 *
 * A follower's own controls are not disabled; whatever it changes is put
 * back by the lead's next message. Passing the lead is the room's
 * business (`workers/rooms`): the longest-connected device leads.
 */

import { connectRoom, type RoomClientHandle, type RoomStatus } from './roomClient'
import type { RoomGlobe, RoomPlayback, RoomState } from './roomProtocol'

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
}

/** How often the lead looks at its own state, ms. */
const LEAD_TICK_MS = 100
/** The lead repeats itself at least this often, changed or not. */
const HEARTBEAT_MS = 1000
/** How often a follower re-checks its playhead against the lead's. */
const FOLLOW_TICK_MS = 250
/** A playing follower seeks when further than this from the lead, seconds. */
const SEEK_PLAYING_S = 0.6
/** A paused follower holds the lead's frame to within this. */
const SEEK_PAUSED_S = 0.08
/** After a seek, leave the decoder alone this long. */
const SEEK_SETTLE_MS = 1500
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
 */
export function followPlayback(
  playback: RoomPlayback,
  elapsedS: number,
  local: { paused: boolean; time: number; duration: number; rate: number },
): PlaybackCorrection {
  const target = (leadTime(playback, elapsedS) / playback.duration) * local.duration
  const off = Math.abs(local.time - target)
  const limit = playback.paused ? SEEK_PAUSED_S : SEEK_PLAYING_S
  return {
    toggle: playback.paused !== local.paused,
    seekTo: off > limit ? Math.max(0, Math.min(local.duration, target)) : null,
    rate: Math.abs(local.rate - playback.rate) > 0.001 ? playback.rate : null,
  }
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
  if (prev.globe && next.globe) {
    if (prev.globe.aligned !== next.globe.aligned) return true
    if (Math.abs(prev.globe.scale - next.globe.scale) > 0.005 * prev.globe.scale) return true
    if (turnBetween(prev.globe.q, next.globe.q) > 0.005) return true
  }
  return false
}

export interface RoomSyncHandle {
  status(): RoomStatus
  /** Called now with the current status, and on every change. Returns an unsubscribe. */
  onStatus(listener: (status: RoomStatus) => void): () => void
  stop(): void
}

export interface RoomSyncOptions {
  /** Clock, for tests. */
  nowMs?: () => number
  /** Build the connection, for tests. */
  connect?: typeof connectRoom
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
  let status: RoomStatus = { code, connected: false, role: null, count: 0 }

  // --- follower side ---
  let followed: { state: RoomState; at: number } | null = null
  let lastSeekAt = -Infinity
  let loadAsked: { id: string; at: number } | null = null

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
    const video = host.getVideo()
    if (!state.playback || !video || !(video.duration > 0) || video.readyState < 2) return
    const fix = followPlayback(state.playback, (now - at) / 1000, {
      paused: !host.isPlaying(),
      time: video.currentTime,
      duration: video.duration,
      rate: video.playbackRate,
    })
    if (fix.rate !== null) video.playbackRate = fix.rate
    if (fix.toggle) host.togglePlayPause()
    if (fix.seekTo !== null && !video.seeking && now - lastSeekAt > SEEK_SETTLE_MS) {
      lastSeekAt = now
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
    return { datasetId: host.getDatasetId(), playback, globe: host.getGlobe() }
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
    onState: (state) => {
      followed = { state, at: nowMs() }
      host.setFollowedGlobe(state.globe)
      follow()
    },
    onStatus: (next) => {
      const was = status.role
      status = next
      if (next.role !== 'follower') {
        // Leading, or cut off: the sphere is this device's own again.
        followed = null
        host.setFollowedGlobe(null)
      }
      // A device that has just become the lead says where things stand at once.
      if (next.role === 'lead' && was !== 'lead') sent = null
      for (const listener of listeners) listener({ ...status })
    },
  })

  const leadTimer = setInterval(lead, LEAD_TICK_MS)
  const followTimer = setInterval(follow, FOLLOW_TICK_MS)

  const handle: RoomSyncHandle = {
    status: () => ({ ...status }),
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
      listeners.clear()
      if (current === handle) current = null
    },
  }
  current = handle
  return handle
}
