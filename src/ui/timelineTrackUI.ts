// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The 2D playback panel's date track - the same strip the headset draws,
 * in the transport where a mouse and a thumb already are.
 *
 * It exists because a real-time stream is a time series pretending to be
 * a video: the scrubber moves through two minutes of encoding that
 * represent thirty days of data, and until now nothing on that panel said
 * which instant the sphere was showing. The axis comes from the stream's
 * own @BT@.dsa@BT@ (@BT@services/dsaTimeline.ts@BT@), the drawing from the shared
 * renderer (@BT@services/timelineTrackCanvas.ts@BT@), and this module is only
 * the DOM half: a canvas sized to its container, pointer and keyboard
 * input, and the ARIA slider semantics the scrubber next to it already
 * has.
 *
 * Three decisions:
 *
 *   - **Rationed seeks.** A pointer drag fires dozens of move events a
 *     second and each seek stalls the decoder. The drawn playhead follows
 *     the pointer at once, while the video is steered at most every
 *     @BT@SCRUB_SEEK_INTERVAL_MS@BT@ - the same ration the headset uses, from one
 *     constant, because it is the same decoder problem.
 *   - **Compact drawing.** The panel is a few hundred pixels wide, so the
 *     renderer drops the header row and lets this strip's own ends carry
 *     the range; the current instant is already on screen in the panel's
 *     time label, which now fills in for these streams too.
 *   - **Keyboard parity.** The strip is a slider to a screen reader and
 *     to the tab key: arrows step one frame of the axis, Home and End jump
 *     to its ends, and @BT@aria-valuetext@BT@ carries the instant rather than a
 *     percentage, because the instant is the thing being chosen.
 *
 * See {@link file://./../../docs/VR_PLAYBACK_TRACK_PLAN.md VR_PLAYBACK_TRACK_PLAN.md}.
 */

import { t } from '../i18n'
import {
  SCRUB_SEEK_INTERVAL_MS,
  drawTimelineTrack,
  formatPlayheadLabel,
  progressAtCanvasX,
  timelineTrackGeometry,
  type TimelineTrackState,
} from '../services/timelineTrackCanvas'

/** CSS height of the strip. The renderer is proportional, so this is a choice. */
const TRACK_HEIGHT_CSS = 56

/** ARIA slider granularity — the strip reports progress in thousandths,
 *  matching the scrubber's own range. */
const ARIA_MAX = 1000

export interface TimelineTrackUIOptions {
  /**
   * The user picked an instant, or dragged to one. Called at most once
   * per {@link SCRUB_SEEK_INTERVAL_MS} while dragging, and once more on
   * release, so a caller may simply seek.
   */
  readonly onSeek: (epochMs: number) => void
}

export interface TimelineTrackUIHandle {
  /** The element to insert into the transport panel. */
  readonly element: HTMLElement
  /** Draw a new axis, or hide the strip with @BT@null@BT@. Idempotent. */
  setState(state: TimelineTrackState | null): void
  isVisible(): boolean
  dispose(): void
}

export function createTimelineTrackUI(
  opts: TimelineTrackUIOptions,
): TimelineTrackUIHandle {
  const element = document.createElement('div')
  element.className = 'timeline-track hidden'
  element.tabIndex = 0
  element.setAttribute('role', 'slider')
  element.setAttribute('aria-label', t('timeline.aria'))
  element.setAttribute('aria-valuemin', '0')
  element.setAttribute('aria-valuemax', String(ARIA_MAX))

  const canvas = document.createElement('canvas')
  element.appendChild(canvas)

  let ctx: CanvasRenderingContext2D | null = null
  let state: TimelineTrackState | null = null
  /** Progress the pointer is holding, or null when no drag is in flight. */
  let dragProgress: number | null = null
  let lastSeekAt = 0
  let disposed = false
  /** What is on the canvas, so a per-frame poll does not repaint for an
   *  unchanged frame. */
  let drawn = ''

  /** Canvas pixels per CSS pixel, so the strip is crisp on a retina panel. */
  function deviceScale(): number {
    return typeof window !== 'undefined' && window.devicePixelRatio > 0
      ? window.devicePixelRatio
      : 1
  }

  /** Size the canvas to its container and return the geometry to draw in.
   *  Geometry is in CSS pixels; the context is scaled, so the renderer's
   *  fractions stay readable numbers. */
  function fit(): ReturnType<typeof timelineTrackGeometry> | null {
    const width = Math.max(1, Math.round(element.clientWidth || 240))
    const height = TRACK_HEIGHT_CSS
    const scale = deviceScale()
    const next = timelineTrackGeometry(width, height)
    const pixelWidth = Math.round(width * scale)
    const pixelHeight = Math.round(height * scale)
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth
      canvas.height = pixelHeight
    }
    canvas.style.height = height + 'px'
    const context = canvas.getContext('2d')
    if (!context) return null
    // Reset before scaling: assigning width above already cleared it, but a
    // fresh transform is what keeps repeated fits from compounding. Guarded
    // because a test context stub need not implement it.
    if (typeof context.setTransform === 'function') {
      context.setTransform(scale, 0, 0, scale, 0, 0)
    }
    ctx = context
    return next
  }

  /** The state as drawn: a drag overrides the playhead so it follows the
   *  pointer even between rationed seeks. */
  function drawnState(): TimelineTrackState | null {
    if (!state) return null
    if (dragProgress === null) return state
    return {
      ...state,
      currentMs: state.startMs + dragProgress * (state.endMs - state.startMs),
      scrubbing: true,
    }
  }

  function signature(next: TimelineTrackState): string {
    const spans = next.availabilitySpans
    return [
      next.startMs,
      next.endMs,
      next.currentMs,
      next.frameCount,
      next.cadenceMs,
      next.scrubbing ? 1 : 0,
      spans.length,
      spans[0]?.startFrame ?? -1,
      spans[spans.length - 1]?.startFrame ?? -1,
      Math.round(element.clientWidth),
    ].join('|')
  }

  function paint(): void {
    const next = drawnState()
    if (!next) {
      element.classList.add('hidden')
      element.removeAttribute('aria-valuenow')
      element.removeAttribute('aria-valuetext')
      drawn = ''
      return
    }
    element.classList.remove('hidden')
    const geometry = fit()
    const key = signature(next)
    if (!ctx || !geometry || key === drawn) {
      if (geometry) updateAria(next)
      return
    }
    drawn = key
    drawTimelineTrack(ctx, next, geometry)
    updateAria(next)
  }

  function updateAria(next: TimelineTrackState): void {
    const span = next.endMs - next.startMs
    const progress = span > 0 ? Math.max(0, Math.min(1, (next.currentMs - next.startMs) / span)) : 0
    element.setAttribute('aria-valuenow', String(Math.round(progress * ARIA_MAX)))
    element.setAttribute('aria-valuetext', formatPlayheadLabel(next.currentMs, next.cadenceMs))
  }

  /** Instant at a client x, or null when the pointer is off the bar. */
  function instantAt(clientX: number): number | null {
    const current = drawnState()
    if (!current) return null
    const rect = canvas.getBoundingClientRect()
    const width = Math.max(1, Math.round(element.clientWidth || 240))
    const geometry = timelineTrackGeometry(width, TRACK_HEIGHT_CSS)
    // The canvas is laid out at the element's width, so a client x maps to
    // canvas x by the rect alone — no device-pixel factor here, because the
    // geometry is in CSS pixels.
    const x = clientX - rect.left
    const progress = progressAtCanvasX(x, geometry)
    if (progress === null) return null
    return current.startMs + progress * (current.endMs - current.startMs)
  }

  function seekFromPointer(clientX: number, commit: boolean): void {
    const current = drawnState()
    if (!current) return
    const rect = canvas.getBoundingClientRect()
    const width = Math.max(1, Math.round(element.clientWidth || 240))
    const progress = progressAtCanvasX(clientX - rect.left, timelineTrackGeometry(width, TRACK_HEIGHT_CSS))
    if (progress === null) return
    dragProgress = progress
    const now = performance.now()
    if (commit || now - lastSeekAt >= SCRUB_SEEK_INTERVAL_MS) {
      lastSeekAt = now
      opts.onSeek(current.startMs + progress * (current.endMs - current.startMs))
    }
    paint()
  }

  function onPointerDown(ev: PointerEvent): void {
    if (!state) return
    ev.preventDefault()
    element.focus()
    try {
      element.setPointerCapture(ev.pointerId)
    } catch {
      // Capture is a nicety; the drag still works without it.
    }
    seekFromPointer(ev.clientX, true)
  }

  function onPointerMove(ev: PointerEvent): void {
    if (dragProgress === null || !state) return
    seekFromPointer(ev.clientX, false)
  }

  function onPointerUp(ev: PointerEvent): void {
    if (dragProgress === null) return
    seekFromPointer(ev.clientX, true)
    dragProgress = null
    paint()
  }

  function onKeyDown(ev: KeyboardEvent): void {
    const current = drawnState()
    if (!current) return
    const step = Math.max(1, current.cadenceMs)
    let target: number | null = null
    if (ev.key === 'ArrowLeft') target = current.currentMs - step
    else if (ev.key === 'ArrowRight') target = current.currentMs + step
    else if (ev.key === 'Home') target = current.startMs
    else if (ev.key === 'End') target = current.endMs - step
    if (target === null) return
    ev.preventDefault()
    dragProgress = null
    opts.onSeek(Math.max(current.startMs, Math.min(current.endMs - step, target)))
  }

  const onResize = (): void => {
    if (state) paint()
  }

  element.addEventListener('pointerdown', onPointerDown)
  element.addEventListener('pointermove', onPointerMove)
  element.addEventListener('pointerup', onPointerUp)
  element.addEventListener('pointercancel', onPointerUp)
  element.addEventListener('keydown', onKeyDown)
  window.addEventListener('resize', onResize)

  return {
    element,
    setState(next) {
      if (disposed) return
      state = next
      if (!next) dragProgress = null
      paint()
    },
    isVisible() {
      return state !== null
    },
    dispose() {
      if (disposed) return
      disposed = true
      element.removeEventListener('pointerdown', onPointerDown)
      element.removeEventListener('pointermove', onPointerMove)
      element.removeEventListener('pointerup', onPointerUp)
      element.removeEventListener('pointercancel', onPointerUp)
      element.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onResize)
      element.remove()
      state = null
      ctx = null
    },
  }
}
