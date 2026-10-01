// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * AYNI — keeps the dataset's date (`#time-label`) at the bottom centre
 * of the globe, clear of whatever else is down there.
 *
 * The label used to sit in the top inline-end corner, where the help
 * button, the account chip and the Enter AR button also live, and at
 * every width some pair of them overlapped. The corner now holds the
 * account chip with Help under it, and the date has the one place on the
 * screen that is the same on every device: the middle of the bottom edge.
 *
 * "Bottom centre" is a column, not a fixed spot. On a desktop the middle
 * of the bottom edge is free; on a phone the playback bar, the Tools
 * buttons and the info panel's header are stacked there, and they grow
 * and shrink (an expanded info panel, a date track, a geo-media panel).
 * So the label is placed by measurement: as low as it can go without
 * touching any of them. `clearBottomOffset` is that rule, pure;
 * `initTimeLabelPosition` re-runs it whenever one of them changes size,
 * is shown or hidden, or moves.
 */

/** A box in the coordinates of the label's containing block. */
export interface Box {
  left: number
  right: number
  top: number
  bottom: number
}

/**
 * How far above the container's bottom edge the label's bottom should
 * sit: `margin` when nothing is in the way, else just above the highest
 * thing it would otherwise touch. `label` gives the label's horizontal
 * extent and height; `gap` is the clear space kept around it.
 */
export function clearBottomOffset(
  containerHeight: number,
  label: { left: number; right: number; height: number },
  obstacles: readonly Box[],
  margin: number,
  gap: number,
): number {
  const inColumn = obstacles.filter(
    (box) => box.left < label.right + gap && box.right > label.left - gap,
  )
  let bottomEdge = containerHeight - margin
  // Each pass lifts the label over everything it currently touches;
  // what it lands on next is found by the following pass.
  for (let pass = 0; pass <= inColumn.length; pass++) {
    let lifted = bottomEdge
    for (const box of inColumn) {
      const touches = box.top < bottomEdge + gap && box.bottom > bottomEdge - label.height - gap
      if (touches) lifted = Math.min(lifted, box.top - gap)
    }
    if (lifted === bottomEdge) break
    bottomEdge = lifted
  }
  return containerHeight - bottomEdge
}

/** What can occupy the bottom of the screen. */
const OBSTACLE_IDS = [
  'playback-controls',
  'geo-media-panel',
  'map-controls',
  'info-panel',
  'chat-trigger',
  'chat-panel',
  'tour-controls',
  'download-manager',
]

let started = false

/**
 * Start keeping `#time-label` clear. Idempotent; a no-op where the label
 * does not exist (the Orbit page, tests).
 */
export function initTimeLabelPosition(): void {
  const label = document.getElementById('time-label')
  if (!label || started) return
  started = true

  let scheduled = false
  const place = (): void => {
    scheduled = false
    if (label.classList.contains('hidden')) return
    const parent = (label.offsetParent ?? document.body).getBoundingClientRect()
    const own = label.getBoundingClientRect()
    if (own.width === 0) return
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
    const obstacles: Box[] = []
    for (const id of OBSTACLE_IDS) {
      const el = document.getElementById(id)
      if (!el || el.classList.contains('hidden')) continue
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      obstacles.push({
        left: rect.left - parent.left,
        right: rect.right - parent.left,
        top: rect.top - parent.top,
        bottom: rect.bottom - parent.top,
      })
    }
    const offset = clearBottomOffset(
      parent.height,
      { left: own.left - parent.left, right: own.right - parent.left, height: own.height },
      obstacles,
      0.75 * rem,
      0.4 * rem,
    )
    const next = `${Math.round(offset)}px`
    if (label.style.bottom !== next) label.style.bottom = next
  }
  const schedule = (): void => {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(place)
  }

  // Sizes: the panels grow and shrink. Attributes: they are shown and
  // hidden by class, and moved by inline style (the Tools bar's bottom).
  const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
  const attributes = new MutationObserver(schedule)
  const watched = new WeakSet<Element>()
  const watch = (el: Element | null): void => {
    if (!el || watched.has(el)) return
    watched.add(el)
    resize?.observe(el)
    attributes.observe(el, { attributes: true, attributeFilter: ['class', 'style'] })
  }
  const watchAll = (): void => {
    watch(label)
    for (const id of OBSTACLE_IDS) watch(document.getElementById(id))
  }
  watchAll()
  // Some panels are created later (the geo-media panel).
  if (label.parentElement) {
    new MutationObserver(() => {
      watchAll()
      schedule()
    }).observe(label.parentElement, { childList: true })
  }
  window.addEventListener('resize', schedule)
  schedule()
}
