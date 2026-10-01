// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Map Controls positioning helper.
 *
 * The actual toolbar UI lives in `toolsMenuUI.ts` now — this module
 * just exposes the positioning helper that sits the map-controls
 * bar above the playback transport when a video is loaded. Kept as a
 * separate file so callers (main.ts) don't need to pull in the full
 * tools-menu module just to reposition.
 */

/**
 * Update the bottom offset of the map-controls host so it sits above
 * the playback controls when a video is loaded. Called from
 * showPlaybackControls and on window resize.
 */
export function updateMapControlsPosition(): void {
  const mapControls = document.getElementById('map-controls')
  if (!mapControls || mapControls.classList.contains('hidden')) return

  // AYNI: a geo-media dataset's panel takes the playback bar's corner.
  const playback = document.getElementById('geo-media-panel') ?? document.getElementById('playback-controls')
  if (playback && !playback.classList.contains('hidden')) {
    watchSize(playback)
    // Measured from the panel's top edge, not its height: at phone
    // width the geo-media panel sits up above the info panel's header.
    const parent = mapControls.offsetParent?.getBoundingClientRect()
    const top = playback.getBoundingClientRect().top
    const above = parent ? parent.bottom - top : playback.offsetHeight + 12
    setBottom(mapControls, `${Math.round(above + 4)}px`)
  } else {
    setBottom(mapControls, '0.75rem')
  }
}

/**
 * Where the bar sits, and the same value as `--map-controls-bottom` for
 * the Tools popover that hangs above it: the popover's height limit is
 * the window less the bar, so it has to know how high the bar was put.
 */
function setBottom(mapControls: HTMLElement, bottom: string): void {
  mapControls.style.bottom = bottom
  mapControls.style.setProperty('--map-controls-bottom', bottom)
}

const watched = new WeakSet<Element>()

/**
 * The bar grows after it is shown — the date track arrives once the
 * stream's `.dsa` has loaded, a cam's picture opens the geo-media panel —
 * so the offset follows its size, not only the calls that show it.
 */
function watchSize(panel: Element): void {
  if (watched.has(panel) || typeof ResizeObserver === 'undefined') return
  watched.add(panel)
  new ResizeObserver(() => updateMapControlsPosition()).observe(panel)
}
