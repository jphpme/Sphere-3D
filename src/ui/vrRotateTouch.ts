// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Post-placement touch input for handheld AR (an Android phone or
 * tablet running the session in Chrome + ARCore).
 *
 * Deliberately the smallest thing that works. On a phone, touch does
 * exactly one job once the globe has been placed:
 *
 *   - **One finger drags sideways → the globe spins on its own axis.**
 *
 * Nothing else. There is no two-finger gesture of any kind — a second
 * finger is ignored outright, it neither scales nor moves nor rotates
 * anything — and no touch on this layer ever writes the globe's scale
 * or position. That is the whole point of the module: the previous
 * layer's one-finger-move / two-finger-pinch / two-finger-twist contract
 * had every stray contact doing something to the globe, and on a phone
 * that read as "any press resizes it". Sizing lives in the explicit
 * zoom slider, placement lives in `vrPlacementTouch`.
 *
 * Why DOM touch and not the XR `select` stream: a screen tap's XR ray
 * starts at the *device* and points through the finger, so a drag
 * arrives as a change of ray direction and cannot be read as finger
 * travel. The DOM sees the real touch point. `vrInteraction` therefore
 * declines its own globe grab while this layer is mounted (see its
 * `domTouchActive` guard), so a drag cannot rotate through both paths.
 *
 * Listener placement: `window` in the capture phase, so the drag works
 * whether the touch lands on the overlay root, the WebXR canvas or empty
 * overlay space — the overlay root is `pointer-events: none` outside
 * Place mode, which is what lets taps fall through to the XR session
 * for the HUD, browse panel and tour strip. Touches that begin on a DOM
 * control (the zoom slider, the placement buttons, any button/input)
 * are left to that control. Nothing is `preventDefault()`ed until the
 * finger has actually travelled, so a plain tap still reaches the XR
 * path unchanged.
 *
 * Headsets never mount this layer — the Quest keeps its controller
 * grab-and-rotate, pinch and thumbstick zoom exactly as before.
 *
 * NOTE: the file lives in `src/ui/` (not `src/services/`) alongside the
 * other DOM-overlay layers so the `check:i18n-strings` lint covers it.
 */

/** Inputs to {@link createVrRotateTouch}. */
export interface VrRotateTouchOptions {
  /**
   * Rotation to apply about the globe's own vertical axis, in radians,
   * for the finger travel since the previous event. Positive when the
   * finger moves toward the screen's right edge.
   */
  readonly onRotate: (deltaRadians: number) => void
}

/** Returned handle. Caller arms it outside Place mode and disposes on
 *  session end. */
export interface VrRotateTouchHandle {
  /** Arm or disarm the layer. Disarming forgets any drag in flight. */
  setEnabled(enabled: boolean): void
  /** Remove listeners. Idempotent. */
  dispose(): void
}

/**
 * Finger travel (CSS px) before a touch counts as a drag rather than a
 * tap. Same threshold as the placement layer: 10 px absorbs a resting
 * finger's jitter without making a deliberate small drag feel dead, and
 * it is what keeps a plain tap from turning into a tiny rotation.
 */
export const ROTATE_DRAG_THRESHOLD_PX = 10

/**
 * How far one full screen width of finger travel turns the globe: one
 * complete revolution. Big enough that a thumb swipe across a phone
 * visibly spins the globe, small enough to aim at a specific country.
 */
export const RADIANS_PER_SCREEN_WIDTH = Math.PI * 2

/**
 * Controls whose touches belong to the control, not to the globe.
 * Mirrors the guard in `vrPlacementTouch`, plus a bare
 * `button`/`input` catch-all.
 */
const CONTROL_SELECTOR =
  '.vr-zoom-overlay, .vr-place-accept, .vr-place-cancel, .vr-place-replace, button, input, select, textarea, a[href]'

/**
 * Pure maths: horizontal finger travel to a rotation delta. Exported
 * for the unit test — it is the only rule this module has.
 */
export function dragToRotation(dxPx: number, screenWidthPx: number): number {
  if (!(screenWidthPx > 0)) return 0
  return (dxPx / screenWidthPx) * RADIANS_PER_SCREEN_WIDTH
}

/** Create the handheld-AR rotate layer. Pure DOM — no Three.js. */
export function createVrRotateTouch(
  opts: VrRotateTouchOptions,
): VrRotateTouchHandle {
  let enabled = false
  let disposed = false

  // Exactly one tracked finger. Any touch that starts while one is
  // already tracked is ignored — that is the "no two-finger anything"
  // rule, enforced by never looking at a second identifier.
  let activeTouchId: number | null = null
  let startX = 0
  let lastX = 0
  let dragging = false

  function findTouch(ev: TouchEvent): Touch | null {
    for (let i = 0; i < ev.changedTouches.length; i++) {
      const touch = ev.changedTouches[i]
      if (touch.identifier === activeTouchId) return touch
    }
    return null
  }

  function reset(): void {
    activeTouchId = null
    dragging = false
  }

  function onTouchStart(ev: TouchEvent): void {
    if (!enabled || activeTouchId !== null) return
    const target = ev.target as HTMLElement | null
    if (target?.closest?.(CONTROL_SELECTOR)) return
    const touch = ev.changedTouches[0]
    if (!touch) return
    activeTouchId = touch.identifier
    startX = touch.clientX
    lastX = touch.clientX
    dragging = false
  }

  function onTouchMove(ev: TouchEvent): void {
    if (!enabled || activeTouchId === null) return
    const touch = findTouch(ev)
    if (!touch) return
    if (!dragging) {
      if (Math.abs(touch.clientX - startX) < ROTATE_DRAG_THRESHOLD_PX) return
      dragging = true
      // Start counting from where the threshold was crossed so the
      // globe does not jump by the dead-zone distance.
      lastX = touch.clientX
    }
    // Only now — a recognised drag — claim the touch so the browser does
    // not scroll or zoom the page underneath.
    if (ev.cancelable) ev.preventDefault()
    const dx = touch.clientX - lastX
    lastX = touch.clientX
    if (dx === 0) return
    const delta = dragToRotation(dx, window.innerWidth)
    if (delta !== 0) opts.onRotate(delta)
  }

  function onTouchEnd(ev: TouchEvent): void {
    if (activeTouchId === null) return
    if (!findTouch(ev)) return
    reset()
  }

  const listeners: Array<[string, EventListener]> = [
    ['touchstart', onTouchStart as EventListener],
    ['touchmove', onTouchMove as EventListener],
    ['touchend', onTouchEnd as EventListener],
    ['touchcancel', onTouchEnd as EventListener],
  ]

  for (const [type, handler] of listeners) {
    window.addEventListener(type, handler, { capture: true, passive: false })
  }

  return {
    setEnabled(next: boolean): void {
      if (disposed || next === enabled) return
      enabled = next
      reset()
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      enabled = false
      reset()
      for (const [type, handler] of listeners) {
        window.removeEventListener(type, handler, { capture: true })
      }
    },
  }
}
