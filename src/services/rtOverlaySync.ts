// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * AYNI — keeping a real-time overlay stream on the base dataset's date.
 *
 * The base video is the master clock: its playhead is a date, and the
 * overlay is steered to the frame for that same date. The two streams
 * rarely advance through data time at the same pace (Global Cloud Cover
 * packs 2 hours into a video second, an hourly base 12), so:
 *
 *   - the overlay's rate is the base's scaled by that ratio, trimmed
 *     gently to ease out drift; a seek only for a real jump (a scrub, a
 *     loop, a stall), since a seek on a playing stream flushes decode;
 *   - where following would push the overlay past
 *     {@link RT_OVERLAY_MAX_RATE}, the base slows instead, so a phone's
 *     decoder never has to run the overlay faster than that;
 *   - a stalled overlay holds the base at a crawl until it catches up,
 *     rather than being seeked again and again (AYNI-2's base pacer);
 *   - outside the overlay's own dates it is hidden and paused.
 *
 * Pure: the caller reads the two elements, applies the decision.
 */

import { MAX_PLAYBACK_RATE, MIN_PLAYBACK_RATE } from '../utils/time'
import { timelineSpanMs, type DsaTimeline } from './dsaTimeline'

/** A stream's data time as a straight line through its video time. */
export interface LinearClock {
  /** Date at video time 0. */
  readonly startMs: number
  /** Exclusive end of the dates the stream covers. */
  readonly endMs: number
  /** Data milliseconds per second of video. */
  readonly msPerSecond: number
}

/** Fastest the overlay is asked to play: a phone decodes 2048 px at 2× a 12 fps stream comfortably. */
export const RT_OVERLAY_MAX_RATE = 2
/** Drift, in overlay video seconds, beyond which a playing overlay is seeked rather than trimmed. */
export const RT_OVERLAY_HARD_SEEK_S = 0.5
/** A paused overlay is realigned when further than this from its frame (under half a 12 fps frame). */
export const RT_OVERLAY_PAUSED_EPS_S = 0.04
/** Rate trim per second of drift, and its cap (as in computeSiblingSyncCorrection). */
const RATE_GAIN = 0.5
const MAX_RATE_TRIM = 0.25
/** `HAVE_FUTURE_DATA`: below it a playing element is waiting on the network. */
const HAVE_FUTURE_DATA = 3

export function clockFromTimeline(timeline: DsaTimeline): LinearClock | null {
  const msPerSecond = timeline.cadenceMs * timeline.videoFrameRate
  if (!(msPerSecond > 0)) return null
  return { startMs: timeline.startMs, endMs: timeline.startMs + timelineSpanMs(timeline), msPerSecond }
}

/** For a dataset that declares only a start, an end and its video's length. */
export function clockFromRange(startMs: number, endMs: number, durationS: number): LinearClock | null {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || !(endMs > startMs) || !(durationS > 0)) return null
  return { startMs, endMs, msPerSecond: (endMs - startMs) / durationS }
}

export interface RtOverlaySyncInput {
  /** The base video, or null when the dataset is a still image. */
  readonly base: { currentTime: number; paused: boolean; clock: LinearClock | null } | null
  readonly overlay: { currentTime: number; paused: boolean; seeking: boolean; readyState: number; clock: LinearClock | null }
  /** The rate the base runs at when no overlay paces it (1, or a tour's). */
  readonly baseUserRate: number
}

export interface RtOverlaySyncDecision {
  /**
   * `synced`: on the base's date. `out-of-range`: the base's date is
   * outside the overlay's. `untimed`: one side has no dates, so the
   * overlay only follows play / pause.
   */
  readonly mode: 'synced' | 'out-of-range' | 'untimed'
  readonly visible: boolean
  readonly playing: boolean
  /** Where to seek the overlay now, or null to leave it. */
  readonly seekTo: number | null
  readonly overlayRate: number
  readonly baseRate: number
}

const clampRate = (r: number) => Math.max(MIN_PLAYBACK_RATE, Math.min(MAX_PLAYBACK_RATE, r))

export function decideRtOverlaySync(input: RtOverlaySyncInput): RtOverlaySyncDecision {
  const { base, overlay, baseUserRate } = input
  const userRate = clampRate(baseUserRate)
  if (!base?.clock || !overlay.clock) {
    return {
      mode: 'untimed',
      visible: true,
      // A still image has no play state to follow: the overlay just runs.
      playing: base ? !base.paused : true,
      seekTo: null,
      overlayRate: 1,
      baseRate: userRate,
    }
  }

  const dateMs = base.clock.startMs + Math.max(0, base.currentTime) * base.clock.msPerSecond
  if (dateMs < overlay.clock.startMs || dateMs >= overlay.clock.endMs) {
    return { mode: 'out-of-range', visible: false, playing: false, seekTo: null, overlayRate: 1, baseRate: userRate }
  }

  const target = (dateMs - overlay.clock.startMs) / overlay.clock.msPerSecond
  // Overlay video seconds per base video second.
  const ratio = base.clock.msPerSecond / overlay.clock.msPerSecond
  const baseRate = clampRate(Math.min(userRate, RT_OVERLAY_MAX_RATE / ratio))
  const pacing = baseRate * ratio
  const error = overlay.currentTime - target // > 0: overlay ahead

  if (base.paused) {
    const seekTo = !overlay.seeking && Math.abs(error) > RT_OVERLAY_PAUSED_EPS_S ? target : null
    return { mode: 'synced', visible: true, playing: false, seekTo, overlayRate: clampRate(pacing), baseRate }
  }

  if (Math.abs(error) > RT_OVERLAY_HARD_SEEK_S) {
    // Leave a seek in flight alone: another write restarts the fetch.
    return {
      mode: 'synced',
      visible: true,
      playing: true,
      seekTo: overlay.seeking ? null : target,
      overlayRate: clampRate(pacing),
      // Hold the base while the overlay lands, so it lands where the base still is.
      baseRate: MIN_PLAYBACK_RATE,
    }
  }

  const trim = Math.max(-MAX_RATE_TRIM, Math.min(MAX_RATE_TRIM, error * RATE_GAIN))
  const stalled = !overlay.paused && (overlay.seeking || overlay.readyState < HAVE_FUTURE_DATA)
  return {
    mode: 'synced',
    visible: true,
    playing: true,
    seekTo: null,
    overlayRate: clampRate(pacing * (1 - trim)),
    baseRate: stalled ? MIN_PLAYBACK_RATE : baseRate,
  }
}
