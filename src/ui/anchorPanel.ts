// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * AYNI — Show anchor (the button under the home button): turns this device's screen into the
 * shared-AR marker (`docs/SHARED_AR_PLAN.md`), for a spare phone or
 * tablet laid flat where the sphere should be. Other phones scan it.
 *
 * The marker is drawn as large as the screen allows: the largest square
 * that fits under the one-line header, on white, whatever the theme. No
 * physical size is aimed for, because the scan never uses one — it
 * measures the marker against the surface under it — so "as large as
 * fits" is the right size on every device.
 *
 * The picture comes from the stream host's R2 bucket, like the shared
 * country borders, and falls back to the copy bundled with the site
 * (`public/ayni-xr-anchor.svg`) when the host is not configured or does
 * not answer. The two are the same file: `ANCHOR_MARKER_KEY` carries a
 * version, and a change to the layout in `sharedMarker.ts` means a new
 * upload under the next one.
 *
 * While open it asks for fullscreen and for the screen to stay awake,
 * both best-effort: a marker that dims or locks mid-session stops being
 * one.
 */

import { t } from '../i18n'

/** The marker's key on the stream host. Immutable: bump the version with the layout. */
export const ANCHOR_MARKER_KEY = 'shared/xr/ayni-xr-anchor-v1.svg'
/** The same picture, bundled with the site. */
export const ANCHOR_MARKER_FALLBACK = '/ayni-xr-anchor.svg'

/** Where the marker is fetched from first. */
export function anchorMarkerUrl(
  base: string | undefined = import.meta.env.VITE_REALTIME_DASH_BASE_URL as string | undefined,
): string {
  const root = base?.trim()
  if (!root) return ANCHOR_MARKER_FALLBACK
  try {
    return new URL(ANCHOR_MARKER_KEY, root.endsWith('/') ? root : `${root}/`).toString()
  } catch {
    return ANCHOR_MARKER_FALLBACK
  }
}

interface WakeLockSentinelLike {
  release(): Promise<void>
}

let closeOpenPanel: (() => void) | null = null

/**
 * Wire `#anchor-btn`. The panel opens straight from the click, because
 * fullscreen needs the user's gesture.
 */
export function initAnchorButton(): void {
  const button = document.getElementById('anchor-btn')
  if (!button || button.dataset.wired === 'true') return
  button.dataset.wired = 'true'
  button.addEventListener('click', () => openAnchorPanel(button))
}

/** True while the anchor is on screen. */
export function isAnchorPanelOpen(): boolean {
  return closeOpenPanel !== null
}

/** Close the anchor if it is open. */
export function closeAnchorPanel(): void {
  closeOpenPanel?.()
}

/**
 * Show the anchor over the whole page. `trigger` gets the focus back
 * when it closes; `source` is where the picture is tried first. Opening
 * it twice is a no-op.
 */
export function openAnchorPanel(
  trigger?: HTMLElement | null,
  source: string = anchorMarkerUrl(),
): void {
  if (closeOpenPanel) return

  const panel = document.createElement('div')
  panel.id = 'anchor-panel'
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', 'true')
  panel.setAttribute('aria-label', t('anchor.title'))

  const header = document.createElement('div')
  header.className = 'anchor-panel-header'
  const hint = document.createElement('p')
  hint.className = 'anchor-panel-hint'
  hint.textContent = t('anchor.hint')
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'anchor-panel-close'
  close.setAttribute('aria-label', t('anchor.close.aria'))
  close.textContent = '✕'
  header.append(hint, close)

  const image = document.createElement('img')
  image.className = 'anchor-panel-marker'
  image.alt = t('anchor.alt')
  image.draggable = false
  const onImageError = (): void => {
    // The stream host did not answer: the bundled copy is the same file.
    image.removeEventListener('error', onImageError)
    if (source !== ANCHOR_MARKER_FALLBACK) image.src = ANCHOR_MARKER_FALLBACK
  }
  image.addEventListener('error', onImageError)
  image.src = source

  panel.append(header, image)
  document.body.appendChild(panel)

  // Keep the screen on. The lock is dropped by the browser whenever the
  // page is hidden, so it is asked for again each time the page returns.
  let wakeLock: WakeLockSentinelLike | null = null
  let closed = false
  const requestWakeLock = (): void => {
    const api = (navigator as Navigator & {
      wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> }
    }).wakeLock
    if (!api || document.visibilityState !== 'visible') return
    api.request('screen').then(
      (lock) => {
        if (closed) void lock.release().catch(() => { /* already released */ })
        else wakeLock = lock
      },
      () => { /* refused (battery saver, no permission): the hint still says to keep it on */ },
    )
  }
  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') requestWakeLock()
  }
  document.addEventListener('visibilitychange', onVisibility)
  requestWakeLock()

  // Fullscreen takes the browser's bars away, which is most of what
  // "as large as the screen allows" means on a phone. Refused without a
  // user gesture, or on iPhone: the panel still covers the page.
  let enteredFullscreen = false
  if (!document.fullscreenElement && typeof panel.requestFullscreen === 'function') {
    panel.requestFullscreen().then(
      () => { enteredFullscreen = true },
      () => { /* not allowed here */ },
    )
  }
  // Leaving fullscreen by the system's own gesture (back, Escape) closes
  // the anchor too: on a phone that gesture is the natural "done".
  const onFullscreenChange = (): void => {
    if (enteredFullscreen && !document.fullscreenElement) doClose()
  }
  document.addEventListener('fullscreenchange', onFullscreenChange)

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      ev.preventDefault()
      doClose()
    } else if (ev.key === 'Tab') {
      // One control: the focus stays on it.
      ev.preventDefault()
      close.focus()
    }
  }
  panel.addEventListener('keydown', onKeyDown)

  function doClose(): void {
    if (closed) return
    closed = true
    closeOpenPanel = null
    document.removeEventListener('visibilitychange', onVisibility)
    document.removeEventListener('fullscreenchange', onFullscreenChange)
    void wakeLock?.release().catch(() => { /* already released */ })
    wakeLock = null
    if (enteredFullscreen && document.fullscreenElement === panel) {
      void document.exitFullscreen().catch(() => { /* already out */ })
    }
    panel.remove()
    trigger?.focus()
  }
  close.addEventListener('click', doClose)
  closeOpenPanel = doClose
  close.focus()
}
