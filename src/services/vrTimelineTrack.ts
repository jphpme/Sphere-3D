// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * In-VR date track - a strip that says *when* the frame on the globe is
 * and lets the user move through the series.
 *
 * A real-time stream is a time series pretending to be a video: 2,880
 * encoded frames at 24 fps is two minutes of playback and thirty days of
 * data. The axis comes from the stream's own `.dsa`
 * ({@link file://./dsaTimeline.ts dsaTimeline.ts}); this module draws it
 * on a CanvasTexture and reports where a ray landed on it, in the
 * `vrTourControls` idiom - the interaction itself belongs to
 * `vrInteraction`, and the polling to `vrSession`.
 *
 * What the strip shows, left to right: the first frame's date, a progress
 * bar with tick marks and the playhead, and the last frame's date. Above
 * the playhead floats the instant it currently represents, which is the
 * question a curator asks in front of an audience ("what are we looking
 * at?"). Spans the DSA flags as `filled` or `missing` are shaded, so a
 * frozen fill does not read as data - the publisher says the last 638 of
 * 2,880 frames repeat earlier ones, and the track is the only place a
 * viewer could ever find that out.
 *
 * Two decisions worth stating:
 *
 *   - **Dates render in UTC.** The axis is declared in UTC and the MPD's
 *     `availabilityStartTime` matches it; a tick labelled in the
 *     viewer's device time would shift under the same stream, and in a
 *     museum the device is nobody's own.
 *   - **Ticks are chosen, not fixed.** A thirty-day axis and a
 *     thirty-one-hour axis need different tick spacing, so the interval
 *     comes from a ladder ({@link chooseTickIntervalMs}) aimed at about
 *     seven labels on any span.
 *
 * Sizing matches the HUD's width so the cluster reads as one control
 * surface; `vrSession` positions it below the HUD and above the tour
 * strip.
 *
 * See {@link file://./../../docs/VR_PLAYBACK_TRACK_PLAN.md VR_PLAYBACK_TRACK_PLAN.md}.
 */

import type * as THREE from 'three'
import type { DsaAvailabilitySpan } from './dsaTimeline'

/** World-space size. Matches the HUD's 0.6 m width, a little taller than the tour strip. */
const TRACK_WIDTH = 0.6
const TRACK_HEIGHT = 0.11

/** Canvas resolution. 5.45:1 matches 0.6 x 0.11 m. */
const CANVAS_WIDTH = 1200
const CANVAS_HEIGHT = 220

/** Bar geometry in canvas pixels - the one source of truth; the UV rect
 *  below is derived from it so the drawing and the hit test cannot drift
 *  apart. */
const BAR_PX = { x: 36, y: 118, w: 1128, h: 52 }

/** The bar's rect in UV space, derived from {@link BAR_PX}. `v` grows
 *  upward in UV and downward in canvas, hence the inversions. */
export const BAR_UV = {
  uMin: BAR_PX.x / CANVAS_WIDTH,
  uMax: (BAR_PX.x + BAR_PX.w) / CANVAS_WIDTH,
  vMin: 1 - (BAR_PX.y + BAR_PX.h) / CANVAS_HEIGHT,
  vMax: 1 - BAR_PX.y / CANVAS_HEIGHT,
} as const

const BG_COLOR = 'rgba(13, 13, 18, 0.85)'
const BORDER_COLOR = 'rgba(255, 255, 255, 0.12)'
const TEXT_COLOR = '#e8eaf0'
const DIM_COLOR = 'rgba(232, 234, 240, 0.6)'
const ACCENT = 'rgba(77, 166, 255, 0.95)'
const ACCENT_FILL = 'rgba(77, 166, 255, 0.45)'
const REMAINDER = 'rgba(255, 255, 255, 0.07)'
const FILLED_SPAN = 'rgba(255, 196, 0, 0.30)'
const MISSING_SPAN = 'rgba(255, 90, 90, 0.34)'
const ESTIMATED_SPAN = 'rgba(120, 200, 255, 0.28)'

/** What the track needs to draw one frame of the axis. */
export interface VrTimelineState {
  /** Instant of frame 0, ms since epoch. */
  readonly startMs: number
  /** Exclusive end of the axis (the instant after the final frame). */
  readonly endMs: number
  /** Instant the playhead represents, ms since epoch. */
  readonly currentMs: number
  readonly frameCount: number
  readonly cadenceMs: number
  /** Sparse provenance spans; a frame inside none of them is ordinary data. */
  readonly availabilitySpans: readonly DsaAvailabilitySpan[]
  /** True while a scrub is in flight - brightens the playhead and frame. */
  readonly scrubbing: boolean
}

export interface VrTimelineTrackHandle {
  readonly mesh: THREE.Mesh
  /** Draw a new axis, or hide the strip with `null`. Idempotent. */
  setState(state: VrTimelineState | null): void
  /** True while a timeline is shown -> the strip is visible. Mirror for vrInteraction. */
  isVisible(): boolean
  /** `'timeline'` when the UV is on the bar, else null. */
  hitTest(uv: { x: number; y: number }): 'timeline' | null
  /**
   * Axis position 0 -> 1 for a UV point on the bar, or null when the ray
   * missed it. The caller converts to a date through `dsaTimeline`.
   */
  progressAtUv(uv: { x: number; y: number }): number | null
  dispose(): void
}

// ---------------------------------------------------------------------------
// Pure layout helpers (exported for tests - no THREE, no canvas)
// ---------------------------------------------------------------------------

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * Tick intervals the ladder may land on, in ms. Reaches weeks and months
 * because a real-time window runs a month and a forecast runs a day; the
 * steps are coarse enough that a label is never cramped.
 */
export const TICK_INTERVALS_MS: readonly number[] = [
  MINUTE,
  5 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  2 * DAY,
  3 * DAY,
  7 * DAY,
  14 * DAY,
  30 * DAY,
  90 * DAY,
  365 * DAY,
]

/**
 * Smallest ladder interval that keeps the tick count at or under
 * `maxTicks`. Falls back to the largest interval when even that is too
 * dense - the caller draws what it gets rather than dropping labels
 * mid-axis.
 */
export function chooseTickIntervalMs(spanMs: number, maxTicks = 7): number {
  const largest = TICK_INTERVALS_MS[TICK_INTERVALS_MS.length - 1]!
  if (!(spanMs > 0) || maxTicks < 1) return largest
  for (const interval of TICK_INTERVALS_MS) {
    if (spanMs / interval <= maxTicks) return interval
  }
  return largest
}

/** Axis progress 0 -> 1 for a UV point on the bar, or null off the bar. */
export function uvToProgress(uv: { x: number; y: number }): number | null {
  if (uv.y < BAR_UV.vMin || uv.y > BAR_UV.vMax) return null
  if (uv.x < BAR_UV.uMin || uv.x > BAR_UV.uMax) return null
  return (uv.x - BAR_UV.uMin) / (BAR_UV.uMax - BAR_UV.uMin)
}

/** Where a progress sits on the bar in UV space - the inverse of
 *  {@link uvToProgress} along the axis. */
export function progressToU(progress: number): number {
  const clamped = Math.max(0, Math.min(1, progress))
  return BAR_UV.uMin + clamped * (BAR_UV.uMax - BAR_UV.uMin)
}

/** Canvas x for an axis progress, for the drawing side. */
export function progressToPx(progress: number): number {
  const clamped = Math.max(0, Math.min(1, progress))
  return BAR_PX.x + clamped * BAR_PX.w
}

/** Compact cadence label: `15m`, `1h`, `6h`, `1d`. Machine-ish on
 *  purpose - the strip's words are numbers, not prose. */
export function formatCadenceShort(cadenceMs: number): string {
  if (!(cadenceMs > 0)) return '-'
  if (cadenceMs < HOUR) return `${Math.round(cadenceMs / MINUTE)}m`
  if (cadenceMs < DAY) {
    const hours = cadenceMs / HOUR
    return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`
  }
  const days = cadenceMs / DAY
  return `${Number.isInteger(days) ? days : days.toFixed(1)}d`
}

/**
 * A tick label: `Aug 18` inside one year, `Aug 2026` across a longer
 * span. UTC and `en-US`, matching the app's date labels
 * (`utils/time.formatDate`) except for the timezone - see the module
 * docstring.
 */
export function formatTickDate(ms: number, spanMs: number): string {
  const opts: Intl.DateTimeFormatOptions =
    spanMs > 300 * DAY
      ? { month: 'short', year: 'numeric', timeZone: 'UTC' }
      : { month: 'short', day: 'numeric', timeZone: 'UTC' }
  return new Date(ms).toLocaleDateString('en-US', opts)
}

/** The instant a playhead label shows: date alone on a daily axis, date
 *  and time when the cadence is sub-daily (a bare date would be useless
 *  at 15-minute steps). */
export function formatPlayheadLabel(ms: number, cadenceMs: number): string {
  const date = new Date(ms)
  return cadenceMs < DAY
    ? date.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'UTC',
      })
    : date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC',
      })
}

function spanColor(availability: DsaAvailabilitySpan['availability']): string {
  switch (availability) {
    case 'filled':
      return FILLED_SPAN
    case 'missing':
      return MISSING_SPAN
    case 'estimated':
      return ESTIMATED_SPAN
    default:
      return REMAINDER
  }
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function drawTrack(ctx: CanvasRenderingContext2D, state: VrTimelineState): void {
  const w = CANVAS_WIDTH
  const h = CANVAS_HEIGHT
  const spanMs = state.endMs - state.startMs

  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = BG_COLOR
  ctx.fillRect(0, 0, w, h)
  ctx.strokeStyle = state.scrubbing ? ACCENT : BORDER_COLOR
  ctx.lineWidth = state.scrubbing ? 3 : 2
  ctx.strokeRect(1.5, 1.5, w - 3, h - 3)

  const progressOf = (ms: number): number =>
    spanMs > 0 ? Math.max(0, Math.min(1, (ms - state.startMs) / spanMs)) : 0

  // --- Header: the axis's ends, and what one step of it is worth ---
  ctx.font = '26px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = TEXT_COLOR
  ctx.textAlign = 'left'
  ctx.fillText(formatTickDate(state.startMs, spanMs), 36, 40)
  ctx.textAlign = 'right'
  ctx.fillText(formatTickDate(state.endMs, spanMs), w - 36, 40)
  ctx.textAlign = 'center'
  ctx.fillStyle = DIM_COLOR
  ctx.font = '24px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
  ctx.fillText(
    `${state.frameCount} - ${formatCadenceShort(state.cadenceMs)}`,
    w / 2,
    40,
  )

  // --- Bar ---
  ctx.fillStyle = REMAINDER
  ctx.fillRect(BAR_PX.x, BAR_PX.y, BAR_PX.w, BAR_PX.h)

  // Provenance spans first, so the elapsed fill reads over them.
  for (const span of state.availabilitySpans) {
    const from = progressOf(state.startMs + span.startFrame * state.cadenceMs)
    const to = progressOf(
      state.startMs + (span.startFrame + span.frameCount) * state.cadenceMs,
    )
    if (to <= from) continue
    ctx.fillStyle = spanColor(span.availability)
    const x0 = BAR_PX.x + from * BAR_PX.w
    const x1 = BAR_PX.x + to * BAR_PX.w
    // A one-frame span is sub-pixel on a month-long axis; a hairline
    // still tells the viewer something happened there.
    ctx.fillRect(x0, BAR_PX.y, Math.max(1.5, x1 - x0), BAR_PX.h)
  }

  // --- Elapsed ---
  const playhead = progressOf(state.currentMs)
  ctx.fillStyle = ACCENT_FILL
  ctx.fillRect(BAR_PX.x, BAR_PX.y, playhead * BAR_PX.w, BAR_PX.h)

  // --- Ticks ---
  const interval = chooseTickIntervalMs(spanMs)
  const firstTick = Math.ceil(state.startMs / interval) * interval
  ctx.font = '22px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
  ctx.textAlign = 'center'
  for (let ms = firstTick; ms < state.endMs; ms += interval) {
    const p = (ms - state.startMs) / spanMs
    if (p <= 0.001 || p >= 0.999) continue
    const x = BAR_PX.x + p * BAR_PX.w
    ctx.fillStyle = 'rgba(255, 255, 255, 0.16)'
    ctx.fillRect(x, BAR_PX.y, 1.5, BAR_PX.h)
    ctx.fillStyle = DIM_COLOR
    ctx.fillText(formatTickDate(ms, spanMs), x, BAR_PX.y + BAR_PX.h + 26)
  }

  // --- Playhead ---
  const playheadX = BAR_PX.x + playhead * BAR_PX.w
  ctx.fillStyle = ACCENT
  ctx.fillRect(playheadX - 1.5, BAR_PX.y - 6, 3, BAR_PX.h + 12)
  ctx.beginPath()
  ctx.arc(playheadX, BAR_PX.y - 10, 7, 0, Math.PI * 2)
  ctx.fill()

  // --- The instant under the playhead, clamped inside the canvas ---
  const label = formatPlayheadLabel(state.currentMs, state.cadenceMs)
  ctx.font = 'bold 28px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
  const textWidth = ctx.measureText(label).width
  const bubbleW = textWidth + 32
  const bubbleX = Math.max(6, Math.min(w - bubbleW - 6, playheadX - bubbleW / 2))
  ctx.fillStyle = 'rgba(6, 12, 24, 0.92)'
  ctx.fillRect(bubbleX, 66, bubbleW, 40)
  ctx.strokeStyle = BORDER_COLOR
  ctx.lineWidth = 1.5
  ctx.strokeRect(bubbleX, 66, bubbleW, 40)
  ctx.fillStyle = TEXT_COLOR
  ctx.textAlign = 'center'
  ctx.fillText(label, bubbleX + bubbleW / 2, 87)
}

// ---------------------------------------------------------------------------
// Widget
// ---------------------------------------------------------------------------

export function createVrTimelineTrack(THREE_: typeof THREE): VrTimelineTrackHandle {
  const canvas = document.createElement('canvas')
  canvas.width = CANVAS_WIDTH
  canvas.height = CANVAS_HEIGHT
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('vrTimelineTrack: 2D canvas context unavailable')

  const texture = new THREE_.CanvasTexture(canvas)
  texture.colorSpace = THREE_.SRGBColorSpace
  texture.minFilter = THREE_.LinearFilter
  texture.magFilter = THREE_.LinearFilter

  const material = new THREE_.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })
  const geometry = new THREE_.PlaneGeometry(TRACK_WIDTH, TRACK_HEIGHT)
  const mesh = new THREE_.Mesh(geometry, material)
  mesh.renderOrder = 10
  mesh.visible = false

  /** Signature of what is on the canvas, so a per-frame poll does not
   *  repaint 1,200 x 220 pixels for an unchanged frame. */
  let drawn = ''
  let visible = false

  function signature(state: VrTimelineState | null): string {
    if (!state) return ''
    const first = state.availabilitySpans[0]?.startFrame ?? -1
    const last =
      state.availabilitySpans[state.availabilitySpans.length - 1]?.startFrame ?? -1
    return [
      state.startMs,
      state.endMs,
      state.currentMs,
      state.frameCount,
      state.cadenceMs,
      state.scrubbing ? 1 : 0,
      state.availabilitySpans.length,
      first,
      last,
    ].join('|')
  }

  const handle: VrTimelineTrackHandle = {
    mesh,

    setState(state) {
      if (!state) {
        visible = false
        mesh.visible = false
        drawn = ''
        return
      }
      mesh.visible = true
      visible = true
      const next = signature(state)
      if (next === drawn) return
      drawn = next
      drawTrack(ctx, state)
      texture.needsUpdate = true
    },

    isVisible() {
      return visible
    },

    hitTest(uv) {
      return handle.progressAtUv(uv) === null ? null : 'timeline'
    },

    progressAtUv(uv) {
      if (!visible) return null
      return uvToProgress(uv)
    },

    dispose() {
      geometry.dispose()
      material.dispose()
      texture.dispose()
    },
  }

  return handle
}
