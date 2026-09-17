// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Placement chrome for handheld-AR globe placement (the `screen` input
 * class): the DOM **Place** and **Cancel** buttons, the step hint, and
 * the idle **Re-place** corner button.
 *
 * Buttons only — this layer owns no gesture. Both placement inputs on a
 * phone are the phone's own aim, driven per frame from `vrSession`'s
 * render loop: the position step follows the hit-test reticle, and the
 * height step follows device tilt. It used to own a vertical drag that
 * set the height as well; that went with the rest of the phone's touch
 * gestures, which are now exactly one — spin the placed globe, in
 * `vrRotateTouch`.
 *
 * What it does own besides the buttons is **interception**. A bare XR
 * `selectstart` fires at touch-down on ANY touch, so "tap anywhere =
 * confirm" makes every stray touch during placement an accidental
 * confirm. While this layer is placing it calls `preventDefault()` on
 * every `beforexrselect` reaching the overlay root (the standard
 * dom-overlays dedup pattern), so XR never sees those touches — stray
 * taps do NOTHING, and the placement advances only via the explicit
 * buttons.
 *
 * Only mounted when the session granted a `dom-overlay` (Android Chrome
 * + ARCore) AND the session was classified handheld. Touches that START
 * on the zoom slider or any of these buttons are left to those
 * elements: the slider has its own `beforexrselect` dedup, and the
 * Re-place button too, since it is visible while the root's dedup
 * listener is disarmed.
 *
 * Controller sessions never mount this layer — they keep trigger-to-
 * confirm and the raycast Place-button tap.
 *
 * NOTE: the file lives in `src/ui/` (not `src/services/`) so the
 * `check:i18n-strings` lint scans it for hard-coded user-visible
 * strings.
 */

import { t } from '../i18n'

/** Inputs to {@link createVrPlacementTouch}. */
export interface VrPlacementTouchOptions {
  /** The DOM **Place** button was tapped — accept the current step
   *  (position → height, height → finalise). Same callback the XR
   *  select path uses for controllers. */
  readonly onConfirm: () => void
  /** The DOM **Cancel** button was tapped — exit Place mode without
   *  placing. */
  readonly onCancel: () => void
  /** The DOM **Re-place** button was tapped — re-enter Place mode at
   *  the position step (same callback as tapping the 3D Place
   *  button). Only fires while NOT placing. */
  readonly onRePlace: () => void
  /** True while the placement flow is in the height step. Read for the
   *  hint text ONLY — this layer turns no gesture into a height
   *  write. */
  readonly isHeightStep: () => boolean
}

/** Returned handle. Self-contained — caller mounts, toggles with
 *  Place mode, and disposes on session end. */
export interface VrPlacementTouchHandle {
  /** Append the buttons + hint to the overlay root. Idempotent. */
  mount(root: HTMLElement): void
  /** Mirror Place mode: swaps the placing chrome (Place / Cancel /
   *  hint) for the idle chrome (Re-place) and arms / disarms the
   *  touch interception. */
  setPlacing(active: boolean): void
  /** Tear down listeners + DOM. Idempotent. */
  dispose(): void
}

/** Create the placement chrome. Pure DOM — no Three.js touch. */
export function createVrPlacementTouch(
  opts: VrPlacementTouchOptions,
): VrPlacementTouchHandle {
  const acceptButton = document.createElement('button')
  acceptButton.type = 'button'
  acceptButton.className = 'vr-place-accept hidden'
  acceptButton.textContent = t('vr.placement.place')
  acceptButton.setAttribute('aria-label', t('vr.placement.place'))

  const cancelButton = document.createElement('button')
  cancelButton.type = 'button'
  cancelButton.className = 'vr-place-cancel hidden'
  cancelButton.textContent = t('vr.placement.cancel')
  cancelButton.setAttribute('aria-label', t('vr.placement.cancel'))

  const replaceButton = document.createElement('button')
  replaceButton.type = 'button'
  replaceButton.className = 'vr-place-replace hidden'
  replaceButton.textContent = t('vr.placement.replace')
  replaceButton.setAttribute('aria-label', t('vr.placement.replace'))

  const hintLabel = document.createElement('div')
  hintLabel.className = 'vr-place-hint hidden'
  hintLabel.setAttribute('role', 'status')

  let root: HTMLElement | null = null
  let placing = false

  /**
   * Taps on overlay DOM elements fire XR `selectstart` on the
   * transient screen input unless prevented. While placing, we own
   * every touch on the overlay root — dedup them all so stray screen
   * taps reach neither the placement confirm short-circuit nor
   * globe-grab in vrInteraction.
   */
  const onBeforeXrSelect = (ev: Event): void => {
    ev.preventDefault()
  }
  // The Re-place button is visible while NOT placing — outside the
  // root's dedup coverage — so it needs its own.
  replaceButton.addEventListener('beforexrselect', onBeforeXrSelect)

  const onAcceptClick = (): void => {
    opts.onConfirm()
    // The confirm may have advanced the step (position → height) or
    // finalised (handle's setPlacing(false) hides the hint anyway).
    refreshHint()
  }

  const onCancelClick = (): void => {
    opts.onCancel()
  }

  const onRePlaceClick = (): void => {
    opts.onRePlace()
  }

  function refreshHint(): void {
    hintLabel.textContent = t(
      opts.isHeightStep()
        ? 'vr.placement.stepHeight'
        : 'vr.placement.stepPosition',
    )
  }

  // Closed-over helpers so the handle methods don't depend on `this`
  // binding — same pattern as vrZoomOverlay (Copilot review of #96).
  function mount(parent: HTMLElement): void {
    if (root) return
    root = parent
    parent.appendChild(acceptButton)
    parent.appendChild(cancelButton)
    parent.appendChild(hintLabel)
    parent.appendChild(replaceButton)
    acceptButton.addEventListener('click', onAcceptClick)
    cancelButton.addEventListener('click', onCancelClick)
    replaceButton.addEventListener('click', onRePlaceClick)
    // Idle chrome: the Re-place button is the only element visible
    // while not placing.
    replaceButton.classList.remove('hidden')
  }

  function setPlacing(active: boolean): void {
    if (placing === active) return
    placing = active
    acceptButton.classList.toggle('hidden', !active)
    cancelButton.classList.toggle('hidden', !active)
    hintLabel.classList.toggle('hidden', !active)
    replaceButton.classList.toggle('hidden', active)
    if (active) refreshHint()
    if (!root) return
    if (active) {
      // Arming interception: the root starts capturing touches (CSS
      // class flips pointer-events) and every beforexrselect is
      // deduped so XR sees none of them.
      root.classList.add('xr-dom-overlay-active')
      root.addEventListener('beforexrselect', onBeforeXrSelect)
    } else {
      root.classList.remove('xr-dom-overlay-active')
      root.removeEventListener('beforexrselect', onBeforeXrSelect)
    }
  }

  function dispose(): void {
    setPlacing(false)
    replaceButton.removeEventListener('beforexrselect', onBeforeXrSelect)
    acceptButton.removeEventListener('click', onAcceptClick)
    cancelButton.removeEventListener('click', onCancelClick)
    replaceButton.removeEventListener('click', onRePlaceClick)
    acceptButton.parentElement?.removeChild(acceptButton)
    cancelButton.parentElement?.removeChild(cancelButton)
    hintLabel.parentElement?.removeChild(hintLabel)
    replaceButton.parentElement?.removeChild(replaceButton)
    root = null
  }

  return { mount, setPlacing, dispose }
}
