/**
 * Touch layer for handheld-AR globe placement (the `screen` input
 * class).
 *
 * Only active when the session was granted a `dom-overlay` (Android
 * Chrome + ARCore): the overlay root then receives real DOM touch
 * events mid-session, which buys us things the raw XR `select`
 * stream can't express:
 *
 *   1. **Explicit acceptance, no implicit confirms.** A bare XR
 *      `selectstart` fires at touch-down on ANY touch, so "tap
 *      anywhere = confirm" makes every stray touch during placement
 *      an accidental confirm. While this layer is placing it calls
 *      `preventDefault()` on every `beforexrselect` reaching the
 *      overlay root (the standard dom-overlays dedup pattern), so
 *      XR never sees those touches — stray taps do NOTHING. The
 *      placement advances only via the explicit DOM buttons:
 *      **Place** (accepts the current step: position → height,
 *      height → finalise) and **Cancel** (exits without placing).
 *   2. **Drag-to-adjust height.** During the height step a vertical
 *      drag on empty screen adjusts the placement height directly
 *      (drag up = higher) via the pure math in
 *      {@link file://./../services/vrHeightControl.ts
 *      vrHeightControl.ts}. Once a drag has set the height, head-tilt
 *      control is latched off for the rest of the step
 *      ({@link VrPlacementTouchHandle.ownsHeight}) so releasing the
 *      finger doesn't snap the globe back to the tilt-driven height
 *      on the next frame.
 *   3. **A reliable re-place affordance.** The floating 6 cm 3D
 *      Place button is a small raycast target for the transient
 *      screen ray; a small DOM **Re-place** corner button (visible
 *      whenever NOT placing) re-enters Place mode at the position
 *      step — a far more forgiving target on a tablet.
 *
 * Touches that START on the zoom slider or any of this layer's
 * buttons are left to those elements (the slider has its own
 * `beforexrselect` dedup; the Re-place button too, since it is
 * visible while the root's dedup listener is disarmed).
 *
 * Controller sessions never mount this layer — they keep tilt for
 * height, trigger-to-confirm, and the raycast Place-button tap.
 *
 * NOTE: the file lives in `src/ui/` (not `src/services/`) so the
 * `check:i18n-strings` lint scans it for hard-coded user-visible
 * strings.
 */

import { dragToHeight } from '../services/vrHeightControl'
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
  /** True while the placement flow is in the height step (drags
   *  adjust height; in the position step drags are ignored). */
  readonly isHeightStep: () => boolean
  /** Current chosen height in metres, or null outside the height
   *  step. Read at drag start as the drag baseline. */
  readonly getHeight: () => number | null
  /** Write a new chosen height (metres). Caller clamps via
   *  `dragToHeight` before calling. */
  readonly setHeight: (heightMeters: number) => void
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
  /** True while a height drag is in flight, or after one completed
   *  during this Place-mode activation — signals the render loop to
   *  leave the height to touch and skip the head-tilt update. */
  ownsHeight(): boolean
  /** Tear down listeners + DOM. Idempotent. */
  dispose(): void
}

/**
 * Finger travel (CSS px) before a touch counts as a drag rather than
 * a stray touch. 10 px absorbs normal resting-finger jitter on a
 * tablet without making deliberate small drags feel dead.
 */
const DRAG_THRESHOLD_PX = 10

/** Create the touch layer. Pure DOM — no Three.js touch. */
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
  /** True once a height drag has completed during this activation —
   *  latches tilt off until Place mode exits (see module docstring). */
  let draggedThisActivation = false

  // Active-touch tracking. Multi-touch is ignored beyond the first
  // finger — placement is a single-pointer flow.
  let activeTouchId: number | null = null
  let startY = 0
  let startHeight: number | null = null
  let dragging = false

  /**
   * Taps on overlay DOM elements fire XR `selectstart` on the
   * transient screen input unless prevented. While placing, we own
   * every touch on the overlay root — dedup them all so stray
   * screen taps reach neither the placement confirm short-circuit
   * nor globe-grab in vrInteraction.
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

  function onTouchStart(ev: TouchEvent): void {
    if (!placing || activeTouchId !== null) return
    // Touches starting on the zoom slider or any of this layer's
    // buttons belong to those elements — don't treat them as
    // placement gestures.
    const target = ev.target as HTMLElement | null
    if (target?.closest('.vr-zoom-overlay, .vr-place-accept, .vr-place-cancel, .vr-place-replace')) return
    const touch = ev.changedTouches[0]
    activeTouchId = touch.identifier
    startY = touch.clientY
    startHeight = opts.getHeight()
    dragging = false
  }

  function onTouchMove(ev: TouchEvent): void {
    if (activeTouchId === null) return
    const touch = findTouch(ev)
    if (!touch) return
    const deltaY = touch.clientY - startY
    if (!dragging && Math.abs(deltaY) >= DRAG_THRESHOLD_PX) {
      dragging = true
    }
    if (dragging && opts.isHeightStep() && startHeight !== null) {
      opts.setHeight(dragToHeight(startHeight, deltaY, window.innerHeight))
    }
  }

  function onTouchEnd(ev: TouchEvent): void {
    if (activeTouchId === null) return
    const touch = findTouch(ev)
    if (!touch) return
    const wasDragging = dragging
    activeTouchId = null
    dragging = false
    // Stray taps do nothing — placement advances only via the
    // explicit Place / Cancel buttons (see module docstring).
    if (wasDragging && opts.isHeightStep()) {
      // Latch: touch owns the height for the rest of this activation
      // so head-tilt doesn't snap the globe back on the next frame.
      draggedThisActivation = true
    }
  }

  function findTouch(ev: TouchEvent): Touch | null {
    for (let i = 0; i < ev.changedTouches.length; i++) {
      if (ev.changedTouches[i].identifier === activeTouchId) {
        return ev.changedTouches[i]
      }
    }
    return null
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
      root.addEventListener('touchstart', onTouchStart)
      root.addEventListener('touchmove', onTouchMove)
      root.addEventListener('touchend', onTouchEnd)
      root.addEventListener('touchcancel', onTouchEnd)
    } else {
      root.classList.remove('xr-dom-overlay-active')
      root.removeEventListener('beforexrselect', onBeforeXrSelect)
      root.removeEventListener('touchstart', onTouchStart)
      root.removeEventListener('touchmove', onTouchMove)
      root.removeEventListener('touchend', onTouchEnd)
      root.removeEventListener('touchcancel', onTouchEnd)
      activeTouchId = null
      dragging = false
      draggedThisActivation = false
    }
  }

  function ownsHeight(): boolean {
    return dragging || draggedThisActivation
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

  return { mount, setPlacing, ownsHeight, dispose }
}
