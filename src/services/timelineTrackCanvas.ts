// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Drawing and hit geometry for a date track — the strip that says *when*
 * the frame on the globe is, and where in the span the playhead sits.
 *
 * Two surfaces draw this: the in-VR plane (`vrTimelineTrack`, a
 * CanvasTexture on a Three.js plane) and the 2D playback panel
 * (`src/ui/timelineTrackUI`, a plain canvas in the transport). They
 * share this module rather than a copy each, because a track that
 * disagreed with the other about where a tick falls or what a shaded
 * span means would be two different claims about the same data.
 *
 * The axis itself is not here: it is parsed in `dsaTimeline.ts` from
 * the stream's `.dsa`. This module takes the resulting
 * {@link TimelineTrackState} and draws it.
 *
 * **Geometry is proportional, never absolute.** Every inset, font size
 * and bar position is a fraction of the canvas, so one implementation
 * covers a 1200 x 220 VR strip and a 280 x 56 panel canvas, and the
 * caller only picks the pixel size. The fractions are the VR numbers
 * divided by 1200/220, which is why the VR drawing did not move when
 * this was extracted.
 *
 * **Compact below 480 px.** A phone-width transport cannot carry a
 * header row, seven tick labels and a date bubble; compact mode drops
 * the header, keeps the ends labelled under the bar, and lets the
 * surrounding UI (the 2D panel's own time label, or the VR HUD's) carry
 * the current instant. The bar, the shaded provenance spans and the
 * playhead survive at every size, because those are the three things the
 * strip exists to say.
 *
 * Dates render in **UTC**, matching the axis and the MPD's
 * `availabilityStartTime`; a tick labelled in the viewer's device
 * timezone would move under a stream that did not.
 *
 * See {@link file://./../../docs/VR_PLAYBACK_TRACK_PLAN.md VR_PLAYBACK_TRACK_PLAN.md}.
 */

// ---------------------------------------------------------------------------
// State and geometry
// ---------------------------------------------------------------------------

/** How the DSA's provenance block describes one span — the subset the drawing needs. */
export interface TimelineAvailabilitySpan {
  readonly startFrame: number
  readonly frameCount: number
  readonly availability: 'real' | 'filled' | 'missing' | 'estimated' | 'unknown'
}

/** Everything the strip needs to draw one frame of the axis. */
export interface TimelineTrackState {
  /** Instant of frame 0, ms since epoch. */
  readonly startMs: number
  /** Exclusive end of the axis (the instant after the final frame). */
  readonly endMs: number
  /** Instant the playhead represents, ms since epoch. */
  readonly currentMs: number
  readonly frameCount: number
  readonly cadenceMs: number
  /** Sparse provenance spans; a frame inside none of them is ordinary data. */
  readonly availabilitySpans: readonly TimelineAvailabilitySpan[]
  /** True while a scrub is in flight — brightens the playhead and frame. */
  readonly scrubbing: boolean
}

/** A canvas's layout, in its own pixels. Derive it; never hard-code it. */
export interface TimelineTrackGeometry {
  readonly width: number
  readonly height: number
  /** The bar the playhead rides, in canvas pixels. */
  readonly bar: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
  /** True when the canvas is too small for a header row and a bubble. */
  readonly compact: boolean
  /** Font size for the header row, in canvas pixels. */
  readonly headerFontPx: number
  /** Font size for tick labels and the end dates. */
  readonly tickFontPx: number
  /** Font size for the playhead's instant bubble. */
  readonly bubbleFontPx: number
}

/** Below this width the header row and the playhead bubble are dropped. */
export const COMPACT_WIDTH_PX = 480

/**
 * Minimum gap between seeks while a scrub is in flight, for every surface
 * that has one. A seek stalls a decoder, and a pointer drag or a
 * controller emits far more events a second than a decoder can answer;
 * the drawn playhead follows the input every frame regardless, so the
 * video catches up in steps while the strip stays smooth. One constant
 * for both, because it is one hardware problem: thirty a second was
 * visibly choppy on a projector and ninety was a permanent stall.
 */
export const SCRUB_SEEK_INTERVAL_MS = 120

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * The VR strip's original pixel geometry, kept as the numerator of every
 * fraction below. Writing 118/220 rather than 0.536 is deliberate: a
 * rounded fraction moves the shipped VR drawing by a fraction of a pixel,
 * which is invisible and makes "the geometry did not change" a claim
 * nobody can check.
 */
const REF_W = 1200
const REF_H = 220

/**
 * Layout for a canvas of this size. The fractions are the original VR
 * strip's pixels over its 1200 x 220 canvas, so that surface renders
 * exactly as it did before both consumers shared this code.
 */
export function timelineTrackGeometry(
  width: number,
  height: number,
): TimelineTrackGeometry {
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  const compact = w < COMPACT_WIDTH_PX
  return {
    width: w,
    height: h,
    bar: {
      x: (36 / REF_W) * w,
      // Compact trades the header row's space for the bar: same canvas
      // height, no room for a date above it.
      y: ((compact ? 66 : 118) / REF_H) * h,
      w: (1128 / REF_W) * w,
      h: ((compact ? 66 : 52) / REF_H) * h,
    },
    compact,
    // Floored at 9 px: a magnified sub-pixel label is worse than a
    // cramped one, and a transport strip is read at a glance.
    headerFontPx: Math.max(9, (26 / REF_W) * w),
    tickFontPx: Math.max(9, (22 / REF_W) * w),
    bubbleFontPx: Math.max(10, (28 / REF_W) * w),
  }
}

// ---------------------------------------------------------------------------
// Progress mapping (the hit geometry)
// ---------------------------------------------------------------------------

/** Axis progress 0 -> 1 for a canvas x, or null outside the bar. */
export function progressAtCanvasX(x: number, geometry: TimelineTrackGeometry): number | null {
  const { bar } = geometry
  if (x < bar.x || x > bar.x + bar.w) return null
  return (x - bar.x) / bar.w
}

/** Canvas x for an axis progress — the inverse of {@link progressAtCanvasX}. */
export function progressToCanvasX(progress: number, geometry: TimelineTrackGeometry): number {
  const clamped = Math.max(0, Math.min(1, progress))
  return geometry.bar.x + clamped * geometry.bar.w
}

/**
 * Axis progress for a UV point on a Three.js plane carrying this canvas,
 * or null when it missed the bar.
 *
 * UV is the plane's space, not the canvas's: `u` runs 0 -> 1 left to
 * right and `v` runs 0 -> 1 **bottom to top**, while canvas y runs
 * top to bottom, so `v` is flipped here. Getting that wrong is how a
 * hit test lands on the mirror image of the point the user aimed at.
 */
export function uvToProgress(
  uv: { x: number; y: number },
  geometry: TimelineTrackGeometry,
): number | null {
  const x = uv.x * geometry.width
  const y = (1 - uv.y) * geometry.height
  const { bar } = geometry
  if (y < bar.y || y > bar.y + bar.h) return null
  return progressAtCanvasX(x, geometry)
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

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
 * dense — the caller draws what it gets rather than dropping labels
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

/**
 * How many tick labels a strip of this width can carry. Roughly one per
 * 150 px, floored at 2 so an axis always shows its middle, and capped at
 * 7 as the VR ladder assumed.
 */
export function tickBudgetForWidth(width: number): number {
  return Math.max(2, Math.min(7, Math.round(width / 150)))
}

/** One label's horizontal extent on its row, in canvas pixels. */
export interface TimelineLabelBox {
  /** Position in the row's own order — what the caller draws by. */
  readonly index: number
  readonly left: number
  readonly right: number
}

/**
 * Which labels survive on one row, left to right, given a minimum gap.
 *
 * The ladder picks a *count*, but a count is not a fit: the labels are
 * dates whose width changes with the span ("Aug 18" against "Aug 2026"),
 * the canvas changes with the panel, and a ladder that tops out can still
 * return more ticks than the budget asked for (a ten-year axis falls
 * through to its largest step and lands ten labels on a phone). Measuring
 * and dropping is the only rule that holds for all three at once.
 *
 * Greedy from the left, because the first label on a row is the one a
 * reader anchors on, and because a dropped label costs a tick's *text*
 * and never its tick line — the marks stay, the axis stays readable, and
 * the spacing stays even to the eye.
 *
 * @param boxes    Label extents, any order; sorted here.
 * @param minGapPx Clear space to leave between two kept labels.
 * @param anchored Indices that must survive — an axis's ends, which are
 *   what the row is *for*; a candidate that would touch one is dropped
 *   instead.
 * @returns The `index`es to draw.
 */
export function distributeLabels(
  boxes: readonly TimelineLabelBox[],
  minGapPx: number,
  anchored: readonly number[] = [],
): number[] {
  const anchoredSet = new Set(anchored)
  const kept = boxes.filter(box => anchoredSet.has(box.index) && box.right >= 0)
  const keptIndexes = kept.map(box => box.index)
  const candidates = boxes
    .filter(box => !anchoredSet.has(box.index) && box.right >= 0)
    .sort((a, b) => a.left - b.left)
  for (const box of candidates) {
    // Against every kept box, not just the last: with two anchored ends the
    // row has a hole in the middle, and a candidate must clear both.
    const collides = kept.some(
      k => box.left < k.right + minGapPx && k.left < box.right + minGapPx,
    )
    if (collides) continue
    kept.push(box)
    keptIndexes.push(box.index)
  }
  keptIndexes.sort((a, b) => a - b)
  return keptIndexes
}

/** Clear space between two labels on a row: a share of the width, with a
 *  floor, because at 200 px a proportional gap rounds to nothing. */
function labelGapPx(width: number): number {
  return Math.max(6, 0.006 * width)
}

/** Compact cadence label: `15m`, `1h`, `6h`, `1d`. Machine-ish on
 *  purpose — the strip's words are numbers, not prose. */
export function formatCadenceShort(cadenceMs: number): string {
  if (!(cadenceMs > 0)) return '-'
  // Sub-minute cadences are real (a one-second satellite loop) and would
  // round to "0m" — a label that says the axis has no step at all.
  if (cadenceMs < MINUTE) return String(Math.max(1, Math.round(cadenceMs / 1000))) + 's'
  if (cadenceMs < HOUR) return String(Math.round(cadenceMs / MINUTE)) + 'm'
  if (cadenceMs < DAY) {
    const hours = cadenceMs / HOUR
    return String(Number.isInteger(hours) ? hours : hours.toFixed(1)) + 'h'
  }
  const days = cadenceMs / DAY
  return String(Number.isInteger(days) ? days : days.toFixed(1)) + 'd'
}

/**
 * A tick label: `Aug 18` inside one year, `Aug 2026` across a longer
 * span. UTC and `en-US`, matching the app's other date labels except for
 * the timezone — see the module docstring.
 */
export function formatTickDate(ms: number, spanMs: number): string {
  const opts: Intl.DateTimeFormatOptions =
    spanMs > 300 * DAY
      ? { month: 'short', year: 'numeric', timeZone: 'UTC' }
      : { month: 'short', day: 'numeric', timeZone: 'UTC' }
  return new Date(ms).toLocaleDateString('en-US', opts)
}

/**
 * A label on the axis, with the precision its *step* deserves.
 *
 * The form follows the step, not the axis: a six-hour axis stepped every
 * three hours and a thirty-hour axis stepped every six both land several
 * labels on the same day, and a row that says "Aug 18" four times explains
 * nothing. So a step shorter than a day prints the day **and the time**,
 * and anything longer prints the day — or the month and year once the span
 * runs past a year, where the day would be noise.
 *
 * The ends are their own case: their step is the whole span, so a six-hour
 * axis labels its ends with times for the same reason.
 */
export function formatAxisLabel(ms: number, stepMs: number, spanMs: number): string {
  if (stepMs < DAY) {
    return new Date(ms).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'UTC',
    })
  }
  return formatTickDate(ms, spanMs)
}

/** An end of the axis: the span is the step. See {@link formatAxisLabel}. */
export function formatAxisEndLabel(ms: number, spanMs: number): string {
  return formatAxisLabel(ms, spanMs, spanMs)
}

/** The instant a playhead label shows: the date alone on a daily axis,
 *  date and time when the cadence is sub-daily (a bare date at 15-minute
 *  steps is useless). */
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

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

const BG_COLOR = 'rgba(13, 13, 18, 0.85)'
const BORDER_COLOR = 'rgba(255, 255, 255, 0.12)'
const TEXT_COLOR = '#e8eaf0'
const DIM_COLOR = 'rgba(232, 234, 240, 0.6)'
const ACCENT = 'rgba(77, 166, 255, 0.95)'
const ACCENT_FILL = 'rgba(77, 166, 255, 0.45)'
const REMAINDER = 'rgba(255, 255, 255, 0.07)'
const TICK_LINE = 'rgba(255, 255, 255, 0.16)'

function spanColor(availability: TimelineAvailabilitySpan['availability']): string {
  switch (availability) {
    case 'filled':
      return 'rgba(255, 196, 0, 0.30)'
    case 'missing':
      return 'rgba(255, 90, 90, 0.34)'
    case 'estimated':
      return 'rgba(120, 200, 255, 0.28)'
    default:
      return REMAINDER
  }
}

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

/** Draw the strip. Pure canvas work: no state is kept, no clock is read. */
export function drawTimelineTrack(
  ctx: CanvasRenderingContext2D,
  state: TimelineTrackState,
  geometry: TimelineTrackGeometry,
): void {
  const { width: w, height: h, bar, compact } = geometry
  const spanMs = state.endMs - state.startMs
  const progressOf = (ms: number): number =>
    spanMs > 0 ? Math.max(0, Math.min(1, (ms - state.startMs) / spanMs)) : 0

  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = BG_COLOR
  ctx.fillRect(0, 0, w, h)
  ctx.strokeStyle = state.scrubbing ? ACCENT : BORDER_COLOR
  ctx.lineWidth = Math.max(1, 0.002 * w)
  ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, w - ctx.lineWidth, h - ctx.lineWidth)

  ctx.textBaseline = 'middle'

  // --- Header: the axis's ends, and what one step of it is worth ---
  // Only when there is room for it; compact leaves the ends to the tick
  // labels below the bar.
  if (!compact) {
    ctx.font = String(geometry.headerFontPx) + 'px ' + MONO
    let startLabel = formatAxisEndLabel(state.startMs, spanMs)
    let endLabel = formatAxisEndLabel(state.endMs, spanMs)
    // Two ends of a short axis carry a time, which is wide; when that
    // cannot fit, the day alone is still true and still identifies the
    // range, so the form degrades before anything is dropped.
    let startW = ctx.measureText(startLabel).width
    let endW = ctx.measureText(endLabel).width
    if (0.03 * w + startW + labelGapPx(w) > 0.97 * w - endW) {
      startLabel = formatTickDate(state.startMs, spanMs)
      endLabel = formatTickDate(state.endMs, spanMs)
      startW = ctx.measureText(startLabel).width
      endW = ctx.measureText(endLabel).width
    }
    const midLabel = String(state.frameCount) + ' - ' + formatCadenceShort(state.cadenceMs)
    const midW = ctx.measureText(midLabel).width
    // The ends are the axis's identity and are drawn unconditionally; the
    // middle summary is the one that yields, because a header that cannot
    // fit its own date range is worse than one without a frame count.
    const keepMid =
      w / 2 - midW / 2 >= 0.03 * w + startW + labelGapPx(w) &&
      w / 2 + midW / 2 <= 0.97 * w - endW - labelGapPx(w)
    ctx.fillStyle = TEXT_COLOR
    ctx.textAlign = 'left'
    ctx.fillText(startLabel, 0.03 * w, 0.182 * h)
    ctx.textAlign = 'right'
    ctx.fillText(endLabel, 0.97 * w, 0.182 * h)
    if (keepMid) {
      ctx.textAlign = 'center'
      ctx.fillStyle = DIM_COLOR
      ctx.fillText(midLabel, w / 2, 0.182 * h)
    }
  }

  // --- Bar ---
  ctx.fillStyle = REMAINDER
  ctx.fillRect(bar.x, bar.y, bar.w, bar.h)

  // Provenance spans first, so the elapsed fill reads over them.
  for (const span of state.availabilitySpans) {
    const from = progressOf(state.startMs + span.startFrame * state.cadenceMs)
    const to = progressOf(
      state.startMs + (span.startFrame + span.frameCount) * state.cadenceMs,
    )
    if (to <= from) continue
    const x0 = bar.x + from * bar.w
    const x1 = bar.x + to * bar.w
    // A one-frame span is sub-pixel on a month-long axis; a hairline still
    // tells the viewer something happened there.
    ctx.fillStyle = spanColor(span.availability)
    ctx.fillRect(x0, bar.y, Math.max(1.5, x1 - x0), bar.h)
  }

  // --- Elapsed ---
  const playhead = progressOf(state.currentMs)
  ctx.fillStyle = ACCENT_FILL
  ctx.fillRect(bar.x, bar.y, playhead * bar.w, bar.h)

  // --- Ticks and their labels, distributed as one row ---
  // The interval ladder picks a count, but a count is not a fit. This row
  // lays every candidate label out, keeps the axis's ends (in compact mode
  // they live here, at the row's extremes) and keeps an interior label
  // only where it clears everything already kept. A dropped label never
  // drops its tick line: the marks carry the rhythm, the text carries the
  // reading, and only the second one may go.
  const interval = chooseTickIntervalMs(spanMs, tickBudgetForWidth(w))
  const firstTick = Math.ceil(state.startMs / interval) * interval
  const tickTimes: number[] = []
  for (let ms = firstTick; ms < state.endMs; ms += interval) {
    const p = (ms - state.startMs) / spanMs
    if (p <= 0.001 || p >= 0.999) continue
    tickTimes.push(ms)
  }

  /** Sentinels for the two end labels, which are not ticks. */
  const END_START = -1
  const END_END = -2
  const rowY = bar.y + bar.h + (compact ? 0.16 : 0.118) * h
  const startLabel = formatAxisEndLabel(state.startMs, spanMs)
  const endLabel = formatAxisEndLabel(state.endMs, spanMs)

  ctx.font = String(geometry.tickFontPx) + 'px ' + MONO
  const tickX = (ms: number): number => bar.x + ((ms - state.startMs) / spanMs) * bar.w
  const tickLabel = (ms: number): string => formatAxisLabel(ms, interval, spanMs)
  const boxes: TimelineLabelBox[] = tickTimes.map((ms, index) => {
    const half = ctx.measureText(tickLabel(ms)).width / 2
    const x = tickX(ms)
    return { index, left: x - half, right: x + half }
  })
  const anchored: number[] = []
  if (compact) {
    const startW = ctx.measureText(startLabel).width
    const endW = ctx.measureText(endLabel).width
    boxes.push({ index: END_START, left: bar.x, right: bar.x + startW })
    boxes.push({ index: END_END, left: bar.x + bar.w - endW, right: bar.x + bar.w })
    anchored.push(END_START, END_END)
  }
  const keep = new Set(distributeLabels(boxes, labelGapPx(w), anchored))

  ctx.fillStyle = TICK_LINE
  for (const ms of tickTimes) {
    ctx.fillRect(tickX(ms), bar.y, Math.max(1, 0.00125 * w), bar.h)
  }

  ctx.fillStyle = DIM_COLOR
  ctx.textAlign = 'center'
  for (let i = 0; i < tickTimes.length; i++) {
    if (!keep.has(i)) continue
    const text = tickLabel(tickTimes[i]!)
    // A tick whose label reads the same as an end says nothing the row has
    // not already said — and on a weekly step the last tick often is the
    // end's own day. The tick line stays; only the echo goes.
    if (text === startLabel || text === endLabel) continue
    ctx.fillText(text, tickX(tickTimes[i]!), rowY)
  }
  if (compact) {
    ctx.textAlign = 'left'
    ctx.fillText(startLabel, bar.x, rowY)
    // Never both when they would touch: the start is the anchor.
    const startW = ctx.measureText(startLabel).width
    const endW = ctx.measureText(endLabel).width
    if (bar.x + startW + labelGapPx(w) <= bar.x + bar.w - endW) {
      ctx.textAlign = 'right'
      ctx.fillText(endLabel, bar.x + bar.w, rowY)
    }
  }

  // --- Playhead ---
  const playheadX = bar.x + playhead * bar.w
  ctx.fillStyle = ACCENT
  ctx.fillRect(playheadX - 1.5, bar.y - 0.027 * h, 3, bar.h + 0.055 * h)
  ctx.beginPath()
  ctx.arc(playheadX, bar.y - 0.045 * h, Math.max(3, 0.0058 * w), 0, Math.PI * 2)
  ctx.fill()

  // --- The instant under the playhead, clamped inside the canvas ---
  if (!compact) {
    const label = formatPlayheadLabel(state.currentMs, state.cadenceMs)
    ctx.font = 'bold ' + String(geometry.bubbleFontPx) + 'px ' + MONO
    const textWidth = ctx.measureText(label).width
    const bubbleW = textWidth + 0.0267 * w
    const bubbleX = Math.max(6, Math.min(w - bubbleW - 6, playheadX - bubbleW / 2))
    const bubbleY = 0.3 * h
    const bubbleH = 0.182 * h
    ctx.fillStyle = 'rgba(6, 12, 24, 0.92)'
    ctx.fillRect(bubbleX, bubbleY, bubbleW, bubbleH)
    ctx.strokeStyle = BORDER_COLOR
    ctx.lineWidth = 1.5
    ctx.strokeRect(bubbleX, bubbleY, bubbleW, bubbleH)
    ctx.fillStyle = TEXT_COLOR
    ctx.textAlign = 'center'
    ctx.fillText(label, bubbleX + bubbleW / 2, bubbleY + bubbleH / 2)
  }
}
