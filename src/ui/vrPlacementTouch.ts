/**
 * Touch layer for handheld-AR Place mode (the `screen` input class).
 *
 * Only active when the session was granted a `dom-overlay` (Android
 * Chrome + ARCore): the overlay root then receives real DOM touch
 * events mid-session, which buys us three things the raw XR `select`
 * stream can't express:
 *
 *   1. **Tap vs. drag disambiguation.** A bare XR `selectstart` fires
 *      at touch-down, so a "confirm on tap" flow can never also
 *      support drag gestures — the confirm would fire before the
 *      finger moves. While this layer is active it calls
 *      `preventDefault()` on every `beforexrselect` reaching the
 *      overlay root (the standard dom-overlays dedup pattern), so
 *      XR never sees the tap, and re-implements confirm itself:
 *      touch-down + touch-up with little movement = tap →
 *      `onConfirm()`.
 *   2. **Drag-to-adjust height.** During the height step a vertical
 *      drag on empty screen adjusts the placement height directly
 *      (drag up = higher) via the pure math in
 *      {@link file://./../services/vrHeightControl.ts
 *      vrHeightControl.ts}. Once a drag has set the height, head-tilt
 *      control is latched off for the rest of the step
 *      ({@link VrPlacementTouchHandle.ownsHeight}) so releasing the
 *      finger doesn't snap the globe back to the tilt-driven height
 *      on the next frame.
 *   3. **A reliable cancel affordance.** The floating 6 cm Place
 *      button is a small raycast target for the transient screen
 *      ray; a DOM "Cancel placement" button is a far more forgiving
 *      target on a tablet. It exits Place mode without placing —
 *      the same "re-tap exits" behaviour the Place button documents.
 *
 * Touches that START on the zoom slider or the cancel button are
 * left to those elements (the slider has its own `beforexrselect`
 * dedup; the button fires `onCancel` on click).
 *
 * Controller sessions never mount this layer — they keep tilt for
 * height and the raycast Place-button tap for cancel.
 *
 * NOTE: the file lives in `src/ui/` (not `src/services/`) so the
 * `check:i18n-strings` lint scans it for hard-coded user-visible
 * strings.
 */

import { dragToHeight } from '../services/vrHeightControl'
import { t } from '../i18n'

/** Inputs to {@link createVrPlacementTouch}. */
export interface VrPlacementTouchOptions {
  /** Tap on empty screen while placing — advance/finalise the
   *  placement (same callback the XR select path uses). */
  readonly onConfirm: () => void
  /** The DOM cancel button was tapped — exit Place mode without
   *  placing. */
  readonly onCancel: () => void
  /** True while the placement flow is in the height step (drags
   *  adjust height; in the position step drags are simply not
   *  confirms). */
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
  /** Append the cancel button to the overlay root. Idempotent. */
  mount(root: HTMLElement): void
  /** Mirror Place mode: shows/hides the cancel button and arms /
   *  disarms the tap+drag interception. */
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
 * a tap. 10 px absorbs normal tap jitter on a tablet without making
 * deliberate small drags feel dead.
 */
const DRAG_THRESHOLD_PX = 10

/** Create the touch layer. Pure DOM — no Three.js touch. */
export function createVrPlacementTouch(
  opts: VrPlacementTouchOptions,
): VrPlacementTouchHandle {
  const cancelButton = document.createElement('button')
  cancelButton.type = 'button'
  cancelButton.className = 'vr-place-cancel hidden'
  cancelButton.textContent = t('vr.placement.cancel')
  cancelButton.setAttribute('aria-label', t('vr.placement.cancel'))

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
   * transient screen input unless prevented. While this layer is
   * armed we own every tap on the overlay root, so dedup them all —
   * confirm is re-synthesized in `onTouchEnd`.
   */
  const onBeforeXrSelect = (ev: Event): void => {
    ev.preventDefault()
  }

  const onCancelClick = (): void => {
    opts.onCancel()
  }

  function onTouchStart(ev: TouchEvent): void {
    if (!placing || activeTouchId !== null) return
    // Touches starting on the zoom slider or the cancel button belong
    // to those elements — don't treat them as placement gestures.
    const target = ev.target as HTMLElement | null
    if (target?.closest('.vr-zoom-overlay, .vr-place-cancel')) return
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
    if (wasDragging) {
      // Latch: touch owns the height for the rest of this activation
      // so head-tilt doesn't snap the globe back on the next frame.
      if (opts.isHeightStep()) draggedThisActivation = true
      return
    }
    // Clean tap — the confirm the XR select path would have fired.
    opts.onConfirm()
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
    parent.appendChild(cancelButton)
  }

  function setPlacing(active: boolean): void {
    if (placing === active) return
    placing = active
    cancelButton.classList.toggle('hidden', !active)
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
      cancelButton.addEventListener('click', onCancelClick)
    } else {
      root.classList.remove('xr-dom-overlay-active')
      root.removeEventListener('beforexrselect', onBeforeXrSelect)
      root.removeEventListener('touchstart', onTouchStart)
      root.removeEventListener('touchmove', onTouchMove)
      root.removeEventListener('touchend', onTouchEnd)
      root.removeEventListener('touchcancel', onTouchEnd)
      cancelButton.removeEventListener('click', onCancelClick)
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
    cancelButton.parentElement?.removeChild(cancelButton)
    root = null
  }

  return { mount, setPlacing, ownsHeight, dispose }
}
