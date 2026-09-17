// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect } from 'vitest'
import {
  BAR_UV,
  TICK_INTERVALS_MS,
  chooseTickIntervalMs,
  formatCadenceShort,
  formatPlayheadLabel,
  formatTickDate,
  progressToPx,
  progressToU,
  uvToProgress,
} from './vrTimelineTrack'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe('chooseTickIntervalMs', () => {
  it('picks a ladder step that keeps the labels near the budget', () => {
    // The aircraft stream's thirty-day window.
    expect(chooseTickIntervalMs(30 * DAY)).toBe(7 * DAY)
    // A 31-hour forecast.
    expect(chooseTickIntervalMs(31 * HOUR)).toBe(6 * HOUR)
    // A two-minute reanalysis clip.
    expect(chooseTickIntervalMs(2 * MINUTE)).toBe(MINUTE)
  })

  it('never returns an interval that is not on the ladder', () => {
    for (const span of [DAY, 3 * DAY, 100 * DAY, 400 * DAY, 10 * MINUTE]) {
      expect(TICK_INTERVALS_MS).toContain(chooseTickIntervalMs(span))
    }
  })

  it('falls back to the largest step for a degenerate span', () => {
    const largest = TICK_INTERVALS_MS[TICK_INTERVALS_MS.length - 1]
    expect(chooseTickIntervalMs(0)).toBe(largest)
    expect(chooseTickIntervalMs(-5)).toBe(largest)
    expect(chooseTickIntervalMs(Number.NaN)).toBe(largest)
    expect(chooseTickIntervalMs(DAY, 0)).toBe(largest)
  })

  it('respects a wider label budget', () => {
    // 30 days at 3-day steps is 10 labels — over the default 7, fine at 12.
    expect(chooseTickIntervalMs(30 * DAY, 12)).toBe(3 * DAY)
  })
})

describe('bar hit geometry', () => {
  it('maps the bar ends to 0 and 1', () => {
    expect(uvToProgress({ x: BAR_UV.uMin, y: (BAR_UV.vMin + BAR_UV.vMax) / 2 })).toBeCloseTo(0, 10)
    expect(uvToProgress({ x: BAR_UV.uMax, y: (BAR_UV.vMin + BAR_UV.vMax) / 2 })).toBeCloseTo(1, 10)
    expect(uvToProgress({ x: (BAR_UV.uMin + BAR_UV.uMax) / 2, y: BAR_UV.vMin })).toBeCloseTo(0.5, 10)
  })

  it('misses above, below and beside the bar', () => {
    expect(uvToProgress({ x: 0.5, y: BAR_UV.vMax + 0.01 })).toBeNull()
    expect(uvToProgress({ x: 0.5, y: BAR_UV.vMin - 0.01 })).toBeNull()
    expect(uvToProgress({ x: BAR_UV.uMin - 0.01, y: 0.5 })).toBeNull()
    expect(uvToProgress({ x: BAR_UV.uMax + 0.01, y: 0.5 })).toBeNull()
  })

  it('inverts the mapping and clamps it', () => {
    for (const p of [0, 0.25, 0.5, 1]) {
      expect(uvToProgress({ x: progressToU(p), y: (BAR_UV.vMin + BAR_UV.vMax) / 2 })).toBeCloseTo(p, 10)
    }
    expect(progressToU(-3)).toBeCloseTo(BAR_UV.uMin, 10)
    expect(progressToU(42)).toBeCloseTo(BAR_UV.uMax, 10)
  })

  it('lays the drawing and the hit test on the same pixels', () => {
    // progressToPx and the UV rect must describe one bar: converting a
    // pixel to UV and back has to land on the same progress.
    for (const p of [0, 0.1, 0.5, 0.9, 1]) {
      const px = progressToPx(p)
      const u = px / 1200
      expect(uvToProgress({ x: u, y: (BAR_UV.vMin + BAR_UV.vMax) / 2 })).toBeCloseTo(p, 6)
    }
  })
})

describe('labels', () => {
  it('writes a cadence the way a curator reads it', () => {
    expect(formatCadenceShort(15 * MINUTE)).toBe('15m')
    expect(formatCadenceShort(HOUR)).toBe('1h')
    expect(formatCadenceShort(6 * HOUR)).toBe('6h')
    expect(formatCadenceShort(1.5 * HOUR)).toBe('1.5h')
    expect(formatCadenceShort(DAY)).toBe('1d')
    expect(formatCadenceShort(15 * DAY)).toBe('15d')
    expect(formatCadenceShort(0)).toBe('-')
  })

  it('labels a tick by day, or by month once the span crosses a year', () => {
    const ms = Date.parse('2026-08-18T14:30:00Z')
    expect(formatTickDate(ms, 30 * DAY)).toBe('Aug 18')
    expect(formatTickDate(ms, 400 * DAY)).toBe('Aug 2026')
  })

  it('prints the time on a sub-daily axis and the year on a daily one', () => {
    const ms = Date.parse('2026-08-18T14:30:00Z')
    expect(formatPlayheadLabel(ms, 15 * MINUTE)).toBe('Aug 18, 14:30')
    expect(formatPlayheadLabel(ms, DAY)).toBe('Aug 18, 2026')
  })

  it('formats in UTC, so a tick cannot move with the device timezone', () => {
    // 23:30 UTC is the next day in every positive-offset timezone; the
    // label must not follow the machine.
    expect(formatTickDate(Date.parse('2026-08-18T23:30:00Z'), 30 * DAY)).toBe('Aug 18')
  })
})
