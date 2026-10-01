// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * AYNI — the marker scan's chrome on a handheld AR session: one corner
 * button that starts and stops the scan, and the hint that says what the
 * scan is waiting for (`vrMarkerAlign.ts` does the scanning).
 *
 * Buttons only, like `vrPlacementTouch`: the scan's input is the phone's
 * own aim. The button swallows its `beforexrselect`, so a tap on it is not
 * also a tap on the globe behind it.
 *
 * Lives in `src/ui/` so `check:i18n-strings` covers its wording.
 */

import { t, type MessageKey } from '../i18n'
import type { MarkerScanStatus } from '../services/vrMarkerAlign'

export interface VrMarkerAlignTouchOptions {
  /** The button was tapped: start the scan, or stop the one running. */
  readonly onToggle: () => void
}

export interface VrMarkerAlignTouchHandle {
  /** Append the button and the hint to the overlay root. Idempotent. */
  mount(root: HTMLElement): void
  /** Mirror the scan. Cheap when nothing changed: call it every frame. */
  setState(scanning: boolean, status: MarkerScanStatus): void
  /** Hide the button while another flow (placement) owns the screen. */
  setHidden(hidden: boolean): void
  dispose(): void
}

/** How long "Aligned" stays up after a scan succeeds. */
const ALIGNED_NOTE_MS = 3000

const HINTS: Record<Exclude<MarkerScanStatus, 'idle'>, MessageKey> = {
  'no-camera': 'vr.marker.hint.noCamera',
  'no-surface': 'vr.marker.hint.noSurface',
  searching: 'vr.marker.hint.searching',
  steadying: 'vr.marker.hint.steadying',
  'not-level': 'vr.marker.hint.notLevel',
  aligned: 'vr.marker.hint.aligned',
}

export function createVrMarkerAlignTouch(
  opts: VrMarkerAlignTouchOptions,
): VrMarkerAlignTouchHandle {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'vr-marker-scan hidden'

  const hint = document.createElement('div')
  hint.className = 'vr-place-hint hidden'
  hint.setAttribute('role', 'status')

  let mounted = false
  let hidden = false
  let scanning: boolean | null = null
  let status: MarkerScanStatus | null = null
  let alignedTimer: ReturnType<typeof setTimeout> | null = null

  const onBeforeXrSelect = (ev: Event): void => {
    ev.preventDefault()
  }
  const onClick = (): void => {
    opts.onToggle()
  }

  function render(): void {
    const label = t(scanning ? 'vr.marker.stop' : 'vr.marker.scan')
    button.textContent = label
    button.setAttribute('aria-label', label)
    button.classList.toggle('hidden', hidden || !mounted)
    const showHint = !hidden && status !== null && status !== 'idle' && (scanning || status === 'aligned')
    hint.classList.toggle('hidden', !showHint)
    if (showHint && status !== null && status !== 'idle') hint.textContent = t(HINTS[status])
  }

  function clearAlignedTimer(): void {
    if (alignedTimer !== null) clearTimeout(alignedTimer)
    alignedTimer = null
  }

  return {
    mount(root) {
      if (mounted) return
      mounted = true
      root.appendChild(button)
      root.appendChild(hint)
      button.addEventListener('click', onClick)
      button.addEventListener('beforexrselect', onBeforeXrSelect)
      render()
    },
    setState(nextScanning, nextStatus) {
      if (nextScanning === scanning && nextStatus === status) return
      scanning = nextScanning
      status = nextStatus
      clearAlignedTimer()
      if (status === 'aligned') {
        // The note goes away by itself; the scan's own status stays
        // "aligned" until the next scan, so the timer hides it here.
        alignedTimer = setTimeout(() => {
          alignedTimer = null
          hint.classList.add('hidden')
        }, ALIGNED_NOTE_MS)
      }
      render()
    },
    setHidden(nextHidden) {
      if (nextHidden === hidden) return
      hidden = nextHidden
      render()
    },
    dispose() {
      clearAlignedTimer()
      button.removeEventListener('click', onClick)
      button.removeEventListener('beforexrselect', onBeforeXrSelect)
      button.remove()
      hint.remove()
      mounted = false
    },
  }
}
