// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import { MIN_PLAYBACK_RATE } from '../utils/time'
import {
  RT_OVERLAY_MAX_RATE,
  clockFromRange,
  clockFromTimeline,
  decideRtOverlaySync,
  type LinearClock,
  type RtOverlaySyncInput,
} from './rtOverlaySync'
import type { DsaTimeline } from './dsaTimeline'

const HOUR = 3_600_000
const AUG_25 = Date.UTC(2026, 7, 25)

function timeline(startMs: number, cadenceMs: number, frameCount: number, videoFrameRate: number): DsaTimeline {
  return {
    startMs,
    declaredEndMs: startMs + frameCount * cadenceMs,
    endMode: 'exclusive',
    frameCount,
    cadenceMs,
    videoFrameRate,
    availability: { spans: [] } as unknown as DsaTimeline['availability'],
  }
}

// The live pair: Surface Temperature (hourly frames at 12 fps, from Aug 10)
// under Global Cloud Cover (10-minute frames at 12 fps, from Aug 25).
const surfaceTemp = clockFromTimeline(timeline(Date.UTC(2026, 7, 10), HOUR, 984, 12))!
const clouds = clockFromTimeline(timeline(AUG_25, HOUR / 6, 4746, 12))!

/** Base video time showing an instant on the surface temperature axis. */
const baseTimeAt = (ms: number) => (ms - surfaceTemp.startMs) / surfaceTemp.msPerSecond
const cloudTimeAt = (ms: number) => (ms - clouds.startMs) / clouds.msPerSecond

function input(over: {
  baseTime?: number
  basePaused?: boolean
  overlayTime?: number
  overlayPaused?: boolean
  seeking?: boolean
  readyState?: number
  baseClock?: LinearClock | null
  overlayClock?: LinearClock | null
  userRate?: number
  noBase?: boolean
} = {}): RtOverlaySyncInput {
  return {
    base: over.noBase ? null : {
      currentTime: over.baseTime ?? baseTimeAt(AUG_25 + 48 * HOUR),
      paused: over.basePaused ?? false,
      clock: over.baseClock === undefined ? surfaceTemp : over.baseClock,
    },
    overlay: {
      currentTime: over.overlayTime ?? cloudTimeAt(AUG_25 + 48 * HOUR),
      paused: over.overlayPaused ?? false,
      seeking: over.seeking ?? false,
      readyState: over.readyState ?? 4,
      clock: over.overlayClock === undefined ? clouds : over.overlayClock,
    },
    baseUserRate: over.userRate ?? 1,
  }
}

describe('clocks', () => {
  it('reads a .dsa axis as data time per video second', () => {
    expect(clouds.msPerSecond).toBe(2 * HOUR)
    expect(surfaceTemp.msPerSecond).toBe(12 * HOUR)
    expect(clouds.endMs - clouds.startMs).toBe(4746 * HOUR / 6)
  })

  it('falls back to a declared range over the video length, and refuses a broken one', () => {
    expect(clockFromRange(0, 10 * HOUR, 5)).toEqual({ startMs: 0, endMs: 10 * HOUR, msPerSecond: 2 * HOUR })
    expect(clockFromRange(0, 10 * HOUR, Number.NaN)).toBeNull()
    expect(clockFromRange(10, 0, 5)).toBeNull()
  })
})

describe('decideRtOverlaySync', () => {
  it('stays still with the base: paused base, paused overlay, on the same date', () => {
    const date = AUG_25 + 30 * HOUR
    const d = decideRtOverlaySync(input({ basePaused: true, baseTime: baseTimeAt(date), overlayTime: 0, overlayPaused: true }))
    expect(d).toMatchObject({ mode: 'synced', visible: true, playing: false })
    expect(d.seekTo).toBeCloseTo(cloudTimeAt(date), 9)
  })

  it('does not seek a paused overlay already on its frame', () => {
    const d = decideRtOverlaySync(input({ basePaused: true, overlayPaused: true }))
    expect(d.seekTo).toBeNull()
  })

  it('slows the base so the overlay never plays faster than the cap', () => {
    // Clouds move 6x slower through data time than the base.
    const d = decideRtOverlaySync(input())
    expect(d.playing).toBe(true)
    expect(d.baseRate).toBeCloseTo(RT_OVERLAY_MAX_RATE / 6, 9)
    expect(d.overlayRate).toBeCloseTo(RT_OVERLAY_MAX_RATE, 9)
  })

  it('leaves the base alone when the overlay can keep up', () => {
    const d = decideRtOverlaySync(input({ baseClock: clouds, baseTime: cloudTimeAt(AUG_25 + 48 * HOUR), userRate: 1.5 }))
    expect(d.baseRate).toBe(1.5)
    expect(d.overlayRate).toBeCloseTo(1.5, 9)
  })

  it('eases small drift out through the rate, without seeking', () => {
    const on = cloudTimeAt(AUG_25 + 48 * HOUR)
    const ahead = decideRtOverlaySync(input({ overlayTime: on + 0.2 }))
    const behind = decideRtOverlaySync(input({ overlayTime: on - 0.2 }))
    expect(ahead.seekTo).toBeNull()
    expect(behind.seekTo).toBeNull()
    expect(ahead.overlayRate).toBeLessThan(RT_OVERLAY_MAX_RATE)
    expect(behind.overlayRate).toBeGreaterThan(RT_OVERLAY_MAX_RATE)
  })

  it('seeks after a jump, holding the base until the overlay lands', () => {
    const d = decideRtOverlaySync(input({ overlayTime: 0 }))
    expect(d.seekTo).toBeCloseTo(cloudTimeAt(AUG_25 + 48 * HOUR), 9)
    expect(d.baseRate).toBe(MIN_PLAYBACK_RATE)
    // A seek already in flight is not restarted.
    expect(decideRtOverlaySync(input({ overlayTime: 0, seeking: true })).seekTo).toBeNull()
  })

  it('holds the base while the overlay waits on the network', () => {
    expect(decideRtOverlaySync(input({ readyState: 2 })).baseRate).toBe(MIN_PLAYBACK_RATE)
  })

  it('hides and pauses the overlay outside its dates, giving the base its own speed back', () => {
    const d = decideRtOverlaySync(input({ baseTime: baseTimeAt(AUG_25 - 24 * HOUR), userRate: 1 }))
    expect(d).toMatchObject({ mode: 'out-of-range', visible: false, playing: false, seekTo: null, baseRate: 1 })
  })

  it('only follows play / pause when either side has no dates', () => {
    expect(decideRtOverlaySync(input({ overlayClock: null, basePaused: true }))).toMatchObject({ mode: 'untimed', playing: false, visible: true })
    expect(decideRtOverlaySync(input({ baseClock: null }))).toMatchObject({ mode: 'untimed', playing: true, baseRate: 1 })
  })

  it('lets the overlay run over a still image', () => {
    expect(decideRtOverlaySync(input({ noBase: true }))).toMatchObject({ mode: 'untimed', playing: true, visible: true })
  })
})
