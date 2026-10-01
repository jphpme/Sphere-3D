// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * AYNI — keeps the globe in the middle of the space the side panels
 * leave free (desktop, single view).
 *
 * The browse panel and the Tools popover open over the inline-end edge
 * of a full-viewport map, so with either open the globe, still centred
 * on the window, reads as off-centre. While one is open the globe glides
 * toward the free side by half the width they take, and glides back when
 * they close.
 *
 * The camera is not touched: MapLibre's own padding would have to be
 * eased through `easeTo`, which cancels the auto-rotate ease and a tour's
 * flight, and every frame of it would go out to the sibling panels and
 * the room. The map surface moves instead. `#map-grid` is widened under
 * the panel by the width taken (`extent`), which puts its centre where
 * the globe belongs and keeps the whole window covered, and the move
 * from the old centre to the new one is a CSS transition on `transform`:
 * the grid is first translated back to where the globe was, then let go.
 * The maps are resized once per change, never per frame.
 *
 * The buttons in the inline-end corners (account chip, Help, Enter AR,
 * the Tools bar) step aside by the same measurement, in any layout: this
 * module publishes how far as custom properties and the stylesheets
 * translate them, on the same time and curve.
 */

/** A panel's horizontal extent, in viewport coordinates. */
export interface PanelBox {
  left: number
  right: number
}

/** Below this the panels are sheets over the globe, not columns beside it. */
const DESKTOP_MIN_WIDTH = 769
/** A panel that takes more than this share of the window leaves no globe to centre. */
const MAX_INSET_FRACTION = 0.6
const DURATION_MS = 650
const EASING = 'cubic-bezier(0.45, 0, 0.15, 1)'

/**
 * The width the open panels take off the inline-end side of the
 * viewport: from the edge to the farthest panel edge. Even, so the half
 * the globe moves by is a whole pixel. Zero when nothing is open, on a
 * narrow window, or when the panels leave too little to centre in.
 */
export function occupiedInset(
  viewportWidth: number,
  panels: readonly PanelBox[],
  rtl: boolean,
): number {
  if (viewportWidth < DESKTOP_MIN_WIDTH) return 0
  let inset = 0
  for (const box of panels) {
    inset = Math.max(inset, rtl ? box.right : viewportWidth - box.left)
  }
  if (inset <= 0 || inset > viewportWidth * MAX_INSET_FRACTION) return 0
  return Math.round(inset / 2) * 2
}

/** How far an element is translated along x right now, mid-transition included. */
function translateX(el: Element): number {
  const m = /matrix\(([^)]+)\)/.exec(getComputedStyle(el).transform ?? '')
  const x = m ? Number(m[1].split(',')[4]) : 0
  return Number.isFinite(x) ? x : 0
}

/** How far the `translate` property has an element pushed along x right now. */
function pushedX(el: Element): number {
  const x = parseFloat(getComputedStyle(el).translate ?? '')
  return Number.isFinite(x) ? x : 0
}

export interface GlobePanelOffsetOptions {
  /** The element that holds the map panels (`#map-grid`). */
  grid: HTMLElement
  /**
   * Resize the maps to the grid's new box and repaint them before the
   * browser paints, so the widened grid never shows a stale canvas.
   */
  resizeMaps: () => void
}

export interface GlobePanelOffsetHandle {
  /** Measure the panels again and move if what they take has changed. */
  refresh(): void
  dispose(): void
}

/**
 * Start following the browse panel and the Tools popover. Both are found
 * by id on every measurement, so it does not matter which exists yet.
 */
export function initGlobePanelOffset(options: GlobePanelOffsetOptions): GlobePanelOffsetHandle {
  const { grid, resizeMaps } = options
  /** How far the grid currently reaches under the panels, px. */
  let extent = 0
  /** The inset the globe is centred for, or on its way to. */
  let target = 0
  let settleTimer: number | null = null

  const rtl = (): boolean => document.documentElement.dir === 'rtl'

  /** The grid's translation toward the panels, mid-transition included. */
  const readTranslate = (): number => {
    const x = translateX(grid)
    return rtl() ? -x : x
  }
  const setTranslate = (toward: number): void => {
    grid.style.transform = `translateX(${rtl() ? -toward : toward}px)`
  }
  const setExtent = (next: number): void => {
    if (next === extent) return
    extent = next
    grid.style.insetInlineStart = next ? `${-next}px` : ''
    resizeMaps()
  }

  /** Rest: the grid reaches exactly as far as the panels, untransformed. */
  const settle = (): void => {
    if (settleTimer !== null) {
      clearTimeout(settleTimer)
      settleTimer = null
    }
    grid.style.transition = ''
    grid.style.transform = ''
    setExtent(target)
  }

  const moveTo = (next: number): void => {
    if (next === target) return
    // Where the globe is now, as a distance from the window's centre.
    const from = extent / 2 - readTranslate()
    target = next
    // Wide enough for both ends of the move, so the window stays covered
    // the whole way; `settle` trims it to the new inset afterwards.
    setExtent(Math.max(extent, next))
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduceMotion) {
      settle()
      return
    }
    grid.style.transition = 'none'
    setTranslate(extent / 2 - from)
    // Commit the starting position before the transition is switched on.
    void grid.offsetWidth
    grid.style.transition = `transform ${DURATION_MS}ms ${EASING}`
    setTranslate(extent / 2 - next / 2)
    if (settleTimer !== null) clearTimeout(settleTimer)
    settleTimer = window.setTimeout(settle, DURATION_MS + 50)
  }

  /**
   * The corner buttons step aside too, by CSS: the account chip, Help
   * and Enter AR by everything that is open (`--panel-push-top`), the
   * Tools bar and the playback transport under it by the browse panel
   * alone (`--panel-push-bar`), since the popover hangs off that bar. `buttons-beside-panel` tells the
   * stylesheets the buttons now stand clear of the browse panel and
   * need not be hidden under it.
   */
  const pushButtons = (top: number, bar: number): void => {
    const sign = rtl() ? 1 : -1
    const root = document.documentElement.style
    if (top) root.setProperty('--panel-push-top', `${sign * top}px`)
    else root.removeProperty('--panel-push-top')
    if (bar) root.setProperty('--panel-push-bar', `${sign * bar}px`)
    else root.removeProperty('--panel-push-bar')
    document.body.classList.toggle('buttons-beside-panel', bar > 0)
  }

  const refresh = (): void => {
    const panels: PanelBox[] = []
    const browse = document.getElementById('browse-overlay')
    if (
      browse &&
      document.body.classList.contains('browse-open') &&
      !browse.classList.contains('hidden')
    ) {
      // The box it is sliding to, not the one mid-slide.
      const width = browse.offsetWidth
      panels.push(rtl() ? { left: 0, right: width } : { left: window.innerWidth - width, right: window.innerWidth })
    }
    const bar = occupiedInset(window.innerWidth, panels, rtl())
    const popover = document.getElementById('tools-menu-popover')
    if (popover && !popover.classList.contains('hidden')) {
      // Where it rests, not where it is while it slides in — and its
      // bar may itself still be on its way to where the browse panel
      // pushes it.
      const rect = popover.getBoundingClientRect()
      const controls = document.getElementById('map-controls')
      const barLag = (rtl() ? bar : -bar) - (controls ? pushedX(controls) : 0)
      const offset = barLag - translateX(popover)
      if (rect.width > 0) panels.push({ left: rect.left + offset, right: rect.right + offset })
    }
    const all = occupiedInset(window.innerWidth, panels, rtl())
    // Both open on a narrow window can be too much for the globe to
    // centre in; the buttons still clear the browse panel.
    pushButtons(all || bar, bar)
    // Two or four globes share the window; there is no one globe to centre.
    const globe = grid.children.length > 1 ? 0 : all
    // For what belongs under the globe (the date label): where it goes.
    const root = document.documentElement.style
    // And for what is anchored to the inline-end edge of its panel (the
    // legend, the colorbar, the map's own corner controls): the whole way.
    const sign = rtl() ? 1 : -1
    if (globe) {
      root.setProperty('--panel-push-globe', `${(sign * globe) / 2}px`)
      root.setProperty('--panel-push-view', `${sign * globe}px`)
    } else {
      root.removeProperty('--panel-push-globe')
      root.removeProperty('--panel-push-view')
    }
    moveTo(globe)
  }

  // Both panels are opened and closed by class: `browse-open` on the
  // body, `hidden` on the popover (which the Tools bar may rebuild).
  const observer = new MutationObserver(refresh)
  const classes = { attributes: true, attributeFilter: ['class'] }
  observer.observe(document.body, classes)
  const controls = document.getElementById('map-controls')
  if (controls) observer.observe(controls, { ...classes, subtree: true, childList: true })
  // Panels come and go with the layout.
  observer.observe(grid, { childList: true })
  window.addEventListener('resize', refresh)
  refresh()

  return {
    refresh,
    dispose(): void {
      observer.disconnect()
      window.removeEventListener('resize', refresh)
      pushButtons(0, 0)
      document.documentElement.style.removeProperty('--panel-push-globe')
      document.documentElement.style.removeProperty('--panel-push-view')
      target = 0
      settle()
    },
  }
}
