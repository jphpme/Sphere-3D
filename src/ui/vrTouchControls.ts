// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Globe manipulation for handheld AR (the `screen` input class) —
 * the post-placement counterpart to `vrPlacementTouch`.
 *
 * The gestures, and why they are DOM-driven rather than XR-driven:
 *
 *   - **One finger drags → the globe moves.** It follows the finger in
 *     the plane facing the camera, so the sphere goes where the user
 *     pushed it.
 *   - **Two fingers pinch → the globe scales.** Separation ratio
 *     against the scale the pinch started from, clamped to the globe's
 *     range.
 *   - **Two fingers twist → the globe rotates**, past a dead zone so a
 *     straight pinch never spins it.
 *
 * XR `select` cannot express these on a phone. A screen-class tap
 * produces a transient input source whose ray starts at the *device*
 * and points *through* the touch point, so a one-finger drag reads as a
 * change of ray direction rather than a change of position, and two
 * fingers arrive as two unrelated transient sources — the existing
 * two-hand path could only read their separation, which is why
 * `vrInteraction` suppresses its pinch on this class. The DOM sees the
 * real touch points, which is the signal these gestures need.
 *
 * `vrInteraction` therefore declines to grab the globe for screen
 * input (see its `isScreenInput` guard) while this layer owns
 * manipulation. Taps that land on the HUD, the browse panel, the tour
 * strip or the Place button still route through the XR path, because
 * touches that begin on this layer's DOM controls are ignored here and
 * this layer never calls `preventDefault()` on a touch-down.
 *
 * Rotation rides the same two-finger gesture rather than a mode: with
 * one finger reserved for moving, twist is the only rotation input a
 * phone has left.
 *
 * Listener placement: `window` in the capture phase, so the gesture
 * works whether the touch lands on the overlay root, the WebXR canvas
 * or empty overlay space — the overlay root itself is
 * `pointer-events: none` outside Place mode, which is what lets taps
 * fall through to the XR session in the first place.
 */

import {
  TWIST_DEADZONE_RAD,
  createTouchGestureTracker,
  dragToWorld,
  pixelsToWorldScale,
  twistAfterDeadzone,
  type TouchPoint,
  type Vec3Like,
} from '../services/vrTouchGesture'

/** Inputs to {@link createVrTouchControls}. */
export interface VrTouchControlsOptions {
  /** One-finger drag resolved to world metres, in globe/reference space. */
  readonly onMove: (delta: Vec3Like) => void
  /** Absolute globe scale for the current pinch. */
  readonly onScale: (scale: number) => void
  /** Twist delta since the previous event, dead zone already removed. */
  readonly onRotate: (deltaRadians: number) => void
  /** Current globe scale (the pinch baseline is taken from it). */
  readonly getScale: () => number
  readonly getMinScale: () => number
  readonly getMaxScale: () => number
  /** Camera → globe-centre distance in metres, for pixel→world sizing. */
  readonly getViewDistance: () => number
  /** Camera vertical field of view, radians. */
  readonly getFovYRad: () => number
  /** Camera right/up axes in world space (the drag plane's basis). */
  readonly getCameraBasis: () => { right: Vec3Like; up: Vec3Like }
}

/** Returned handle. Caller enables/disables with Place mode and
 *  disposes on session end. */
export interface VrTouchControlsHandle {
  /** Arm or disarm the layer. Disarming forgets any gesture in flight. */
  setEnabled(enabled: boolean): void
  /** Remove listeners. Idempotent. */
  dispose(): void
}

/**
 * Controls whose touches belong to the control, not to the globe —
 * the zoom slider and the placement buttons. Mirrors the same guard in
 * `vrPlacementTouch`, plus a bare `button`/`input` catch-all.
 */
const CONTROL_SELECTOR =
  '.vr-zoom-overlay, .vr-place-accept, .vr-place-cancel, .vr-place-replace, button, input, select, textarea, a[href]'

/** Create the handheld-AR touch layer. Pure DOM + the pure maths in
 *  `vrTouchGesture`; no Three.js. */
export function createVrTouchControls(
  opts: VrTouchControlsOptions,
): VrTouchControlsHandle {
  const tracker = createTouchGestureTracker()
  /** Identifiers of touches that began away from a DOM control. */
  const ownedIds = new Set<number>()
  let enabled = false
  let disposed = false
  /** Dead-zoned twist already handed to the caller for this pinch, so
   *  each event reports only the extra rotation. */
  let appliedTwistRad = 0

  /**
   * The touches the browser currently reports on the screen, from the
   * event being handled — a `TouchList` is only reachable through an
   * event, so every entry point stores it before asking for points.
   */
  let lastTouches: TouchList = [] as unknown as TouchList

  /** The owned touches, in the order the browser reports them. Only
   *  the first two matter (see `vrTouchGesture`). */
  function currentPoints(): TouchPoint[] {
    const points: TouchPoint[] = []
    for (const touch of Array.from(lastTouches)) {
      if (!ownedIds.has(touch.identifier)) continue
      points.push({ id: touch.identifier, x: touch.clientX, y: touch.clientY })
      if (points.length === 2) break
    }
    return points
  }

  function dropFinishedTouches(ev: TouchEvent): void {
    const live = new Set<number>()
    for (const touch of Array.from(ev.touches)) live.add(touch.identifier)
    for (const id of Array.from(ownedIds)) {
      if (!live.has(id)) ownedIds.delete(id)
    }
  }

  function onTouchStart(ev: TouchEvent): void {
    if (!enabled) return
    lastTouches = ev.touches
    for (const touch of Array.from(ev.changedTouches)) {
      const target = ev.target as HTMLElement | null
      if (target?.closest?.(CONTROL_SELECTOR)) continue
      ownedIds.add(touch.identifier)
    }
    // A down/up that changes the finger set re-baselines inside the
    // tracker (it returns null for that event) — no jump either way.
    tracker.update(currentPoints(), gestureContext())
  }

  function onTouchMove(ev: TouchEvent): void {
    if (!enabled || ownedIds.size === 0) return
    lastTouches = ev.touches
    const gesture = tracker.update(currentPoints(), gestureContext())
    if (!gesture) return
    // Only now — a recognised gesture — do we claim the touch and stop
    // the browser from scrolling or zooming the page underneath.
    if (ev.cancelable) ev.preventDefault()

    if (gesture.kind === 'move') {
      const worldPerPixel = pixelsToWorldScale(
        opts.getViewDistance(),
        opts.getFovYRad(),
        window.innerHeight,
      )
      if (worldPerPixel <= 0) return
      const basis = opts.getCameraBasis()
      opts.onMove(dragToWorld(gesture.dxPx, gesture.dyPx, worldPerPixel, basis.right, basis.up))
      return
    }

    opts.onScale(gesture.scale)
    const effective = twistAfterDeadzone(gesture.rotationRad, TWIST_DEADZONE_RAD)
    const delta = effective - appliedTwistRad
    appliedTwistRad = effective
    if (delta !== 0) opts.onRotate(delta)
  }

  function onTouchEnd(ev: TouchEvent): void {
    if (!enabled) return
    lastTouches = ev.touches
    dropFinishedTouches(ev)
    if (ownedIds.size < 2) appliedTwistRad = 0
    tracker.update(currentPoints(), gestureContext())
  }

  function gestureContext() {
    return {
      scale: opts.getScale(),
      minScale: opts.getMinScale(),
      maxScale: opts.getMaxScale(),
    }
  }

  const listeners: Array<[string, EventListener]> = [
    ['touchstart', onTouchStart as EventListener],
    ['touchmove', onTouchMove as EventListener],
    ['touchend', onTouchEnd as EventListener],
    ['touchcancel', onTouchEnd as EventListener],
  ]

  function attach(): void {
    for (const [type, handler] of listeners) {
      window.addEventListener(type, handler, { capture: true, passive: false })
    }
  }

  function detach(): void {
    for (const [type, handler] of listeners) {
      window.removeEventListener(type, handler, { capture: true })
    }
  }

  attach()

  return {
    setEnabled(next: boolean): void {
      if (disposed || next === enabled) return
      enabled = next
      ownedIds.clear()
      appliedTwistRad = 0
      lastTouches = [] as unknown as TouchList
      tracker.reset()
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      enabled = false
      ownedIds.clear()
      tracker.reset()
      detach()
    },
  }
}
