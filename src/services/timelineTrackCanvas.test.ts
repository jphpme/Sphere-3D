// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect, vi } from 'vitest'
import {
  COMPACT_WIDTH_PX,
  TICK_INTERVALS_MS,
  chooseTickIntervalMs,
  drawTimelineTrack,
  formatCadenceShort,
  formatPlayheadLabel,
  formatTickDate,
  progressAtCanvasX,
  progressToCanvasX,
  tickBudgetForWidth,
  timelineTrackGeometry,
  uvToProgress,
  type TimelineTrackState,
} from './timelineTrackCanvas'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** The VR strip's canvas, and the 2D playback panel's. */
const VR = timelineTrackGeometry(1200, 220)
const PANEL = timelineTrackGeometry(280, 56)

const START = Date.parse('2026-08-18T14:30:00Z')

const STATE: TimelineTrackState = {
  startMs: START,
  endMs: START + 30 * DAY,
  currentMs: START + 12 * DAY,
  frameCount: 2880,
  cadenceMs: 15 * MINUTE,
  availabilitySpans: [
    { startFrame: 4, frameCount: 1, availability: 'filled' },
    { startFrame: 100, frameCount: 4, availability: 'missing' },
  ],
  scrubbing: false,
}

/** Minimal 2D context: enough for the drawing path, with the calls
 *  recorded so the geometry and the paint cannot drift apart. */
function fakeCtx() {
  const ctx = {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    fillText: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    measureText: vi.fn((text: string) => ({ width: text.length * 8 })),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
  }
  return ctx as unknown as CanvasRenderingContext2D & {
    fillRect: ReturnType<typeof vi.fn>
    fillText: ReturnType<typeof vi.fn>
  }
}

describe('timelineTrackGeometry', () => {
  it('reproduces the VR strip exactly, because the fractions came from it', () => {
    // These are the numbers the VR track shipped with before the renderer
    // was shared; if this test moves, that surface moved.
    expect(VR.compact).toBe(false)
    expect(VR.bar.x).toBeCloseTo(36, 6)
    expect(VR.bar.y).toBeCloseTo(118, 6)
    expect(VR.bar.w).toBeCloseTo(1128, 6)
    expect(VR.bar.h).toBeCloseTo(52, 6)
    expect(VR.headerFontPx).toBeCloseTo(26, 6)
  })

  it('goes compact for a transport-sized canvas and keeps a usable font', () => {
    expect(PANEL.compact).toBe(true)
    expect(PANEL.bar.w).toBeLessThanOrEqual(PANEL.width)
    expect(PANEL.bar.y + PANEL.bar.h).toBeLessThan(PANEL.height)
    expect(PANEL.tickFontPx).toBeGreaterThanOrEqual(9)
    expect(timelineTrackGeometry(COMPACT_WIDTH_PX - 1, 60).compact).toBe(true)
    expect(timelineTrackGeometry(COMPACT_WIDTH_PX, 60).compact).toBe(false)
  })

  it('never produces a degenerate geometry', () => {
    const tiny = timelineTrackGeometry(0, 0)
    expect(tiny.width).toBeGreaterThan(0)
    expect(tiny.height).toBeGreaterThan(0)
    expect(tiny.bar.w).toBeGreaterThan(0)
  })
})

describe('progress mapping', () => {
  it('maps the bar ends to 0 and 1, in every size', () => {
    for (const geom of [VR, PANEL]) {
      expect(progressAtCanvasX(geom.bar.x, geom)).toBeCloseTo(0, 10)
      expect(progressAtCanvasX(geom.bar.x + geom.bar.w, geom)).toBeCloseTo(1, 10)
      expect(progressAtCanvasX(geom.bar.x + geom.bar.w / 2, geom)).toBeCloseTo(0.5, 10)
    }
  })

  it('misses beside the bar', () => {
    expect(progressAtCanvasX(VR.bar.x - 1, VR)).toBeNull()
    expect(progressAtCanvasX(VR.bar.x + VR.bar.w + 1, VR)).toBeNull()
  })

  it('inverts the mapping and clamps it', () => {
    for (const p of [0, 0.25, 0.5, 1]) {
      expect(progressAtCanvasX(progressToCanvasX(p, VR), VR)).toBeCloseTo(p, 10)
    }
    expect(progressToCanvasX(-3, VR)).toBeCloseTo(VR.bar.x, 10)
    expect(progressToCanvasX(9, VR)).toBeCloseTo(VR.bar.x + VR.bar.w, 10)
  })

  it('reads a UV point with v flipped, and misses above and below the bar', () => {
    const midV = 1 - (VR.bar.y + VR.bar.h / 2) / VR.height
    expect(uvToProgress({ x: 0, y: midV }, VR)).toBeNull()
    expect(uvToProgress({ x: 1, y: midV }, VR)).toBeNull()
    // The bar is inset from the plane's edges, so the ends of the axis sit
    // at the bar's corners rather than at u = 0 and u = 1.
    const uAt = (px: number) => px / VR.width
    expect(uvToProgress({ x: uAt(VR.bar.x), y: midV }, VR)).toBeCloseTo(0, 10)
    expect(uvToProgress({ x: uAt(VR.bar.x + VR.bar.w), y: midV }, VR)).toBeCloseTo(1, 10)
    expect(
      uvToProgress({ x: uAt(VR.bar.x + VR.bar.w / 2), y: midV }, VR),
    ).toBeCloseTo(0.5, 10)
    // Below the bar in canvas terms is a *lower* v; above it is higher.
    expect(uvToProgress({ x: 0.5, y: 1 - (VR.bar.y + VR.bar.h + 2) / VR.height }, VR)).toBeNull()
    expect(uvToProgress({ x: 0.5, y: 1 - (VR.bar.y - 2) / VR.height }, VR)).toBeNull()
  })
})

describe('chooseTickIntervalMs', () => {
  it('picks a ladder step that keeps the labels near the budget', () => {
    expect(chooseTickIntervalMs(30 * DAY)).toBe(7 * DAY)
    expect(chooseTickIntervalMs(31 * HOUR)).toBe(6 * HOUR)
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
    expect(chooseTickIntervalMs(30 * DAY, 12)).toBe(3 * DAY)
  })

  it('sizes the budget to the width, between two and seven labels', () => {
    expect(tickBudgetForWidth(1200)).toBe(7)
    expect(tickBudgetForWidth(280)).toBe(2)
    expect(tickBudgetForWidth(600)).toBe(4)
    expect(tickBudgetForWidth(1)).toBe(2)
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
    expect(formatTickDate(START, 30 * DAY)).toBe('Aug 18')
    expect(formatTickDate(START, 400 * DAY)).toBe('Aug 2026')
  })

  it('prints the time on a sub-daily axis and the year on a daily one', () => {
    expect(formatPlayheadLabel(START, 15 * MINUTE)).toBe('Aug 18, 14:30')
    expect(formatPlayheadLabel(START, DAY)).toBe('Aug 18, 2026')
  })

  it('formats in UTC, so a tick cannot move with the device timezone', () => {
    expect(formatTickDate(Date.parse('2026-08-18T23:30:00Z'), 30 * DAY)).toBe('Aug 18')
  })
})

describe('drawTimelineTrack', () => {
  it('paints the bar exactly where the hit test expects it', () => {
    const ctx = fakeCtx()
    drawTimelineTrack(ctx, STATE, VR)
    const barPaints = ctx.fillRect.mock.calls.filter(
      call => call[0] === VR.bar.x && call[3] === VR.bar.h,
    )
    // The empty bar spans the whole width; the elapsed fill over it spans
    // only up to the playhead.
    const widths = barPaints.map(call => call[2] as number).sort((a, b) => a - b)
    expect(widths[widths.length - 1]).toBeCloseTo(VR.bar.w, 10)
    expect(widths[0]).toBeLessThan(VR.bar.w)
    expect(widths[0]).toBeGreaterThan(0)
  })

  it('draws at least one labelled tick and the axis ends', () => {
    const ctx = fakeCtx()
    drawTimelineTrack(ctx, STATE, VR)
    const labels = ctx.fillText.mock.calls.map(call => String(call[0]))
    expect(labels.some(text => /Aug|Sep/.test(text))).toBe(true)
    expect(labels.some(text => text.includes('2880'))).toBe(true)
  })

  it('survives a degenerate state without throwing', () => {
    const ctx = fakeCtx()
    const degenerate: TimelineTrackState = {
      ...STATE,
      startMs: START,
      endMs: START,
      frameCount: 0,
      cadenceMs: 0,
      availabilitySpans: [],
    }
    expect(() => drawTimelineTrack(ctx, degenerate, VR)).not.toThrow()
    expect(() => drawTimelineTrack(ctx, degenerate, PANEL)).not.toThrow()
  })

  it('drops the header row on a compact canvas but still labels the ends', () => {
    const ctx = fakeCtx()
    drawTimelineTrack(ctx, STATE, PANEL)
    const labels = ctx.fillText.mock.calls.map(call => String(call[0]))
    // No frame-count summary in compact mode...
    expect(labels.some(text => text.includes('2880'))).toBe(false)
    // ...but the two ends are still dated.
    expect(labels.filter(text => /Aug|Sep/.test(text)).length).toBeGreaterThanOrEqual(2)
  })
})
