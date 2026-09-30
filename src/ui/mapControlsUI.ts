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
    // Measured from the panel's top edge, not its height: at phone
    // width the geo-media panel sits up above the info panel's header.
    const parent = mapControls.offsetParent?.getBoundingClientRect()
    const top = playback.getBoundingClientRect().top
    const above = parent ? parent.bottom - top : playback.offsetHeight + 12
    mapControls.style.bottom = `${Math.round(above + 4)}px`
  } else {
    mapControls.style.bottom = '0.75rem'
  }
}
