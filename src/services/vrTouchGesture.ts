// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Pure gesture maths for the handheld-AR touch layer
 * (`src/ui/vrTouchControls.ts`).
 *
 * Handheld AR (Android + ARCore, the `screen` input class) gets its
 * globe manipulation from **DOM touch events**, not from XR `select`:
 *
 *   - one finger drags  → the globe **moves** with the finger
 *   - two fingers pinch → the globe **scales**
 *   - two fingers twist → the globe **rotates** (past a dead zone)
 *
 * Why not the XR path: a screen-class tap produces a transient input
 * source whose ray starts at the *device* and points through the touch,
 * so a one-finger drag gives a direction change rather than a position,
 * and two fingers arrive as two unrelated transient sources whose
 * "pinch" is a ratio of ray separations. The DOM layer sees the actual
 * touch points, which is the signal the gestures above need.
 *
 * Everything here is plain arithmetic — no DOM, no Three.js — so the
 * gesture rules stay unit-testable on a machine with no AR hardware
 * (the split `vrHeightControl` and `vrSpawn` already use).
 */

/** A live touch point in CSS pixels, in viewport coordinates. */
export interface TouchPoint {
  /** `Touch.identifier` — stable for the life of one finger-down. */
  id: number
  x: number
  y: number
}

/** A plain vector, kept structural so callers can hand in Three.js
 *  vectors without this module importing Three. */
export interface Vec3Like {
  x: number
  y: number
  z: number
}

/** One frame of recognised gesture output. */
export type TouchGesture =
  /** One finger moved by `(dxPx, dyPx)` since the previous event. */
  | { kind: 'move'; dxPx: number; dyPx: number }
  /** Two fingers: absolute scale to apply, plus the accumulated twist
   *  in radians since this pinch began (callers dead-zone it). */
  | { kind: 'pinch'; scale: number; rotationRad: number }

/** Inputs the tracker needs from the caller on each update. */
export interface TouchGestureContext {
  /** Current globe scale — captured as the baseline when a pinch starts. */
  scale: number
  minScale: number
  maxScale: number
}

/**
 * Twist smaller than this does not rotate the globe.
 *
 * A two-finger pinch is never perfectly straight — fingers drift a few
 * degrees — and without a dead zone every pinch would spin the globe a
 * little. 12° is past that drift and still short enough that a
 * deliberate twist answers immediately.
 */
export const TWIST_DEADZONE_RAD = (12 * Math.PI) / 180

/** Scale for a pinch: the ratio of finger separation, applied to the
 *  scale the gesture started from, clamped to the globe's range. */
export function pinchScale(
  startScale: number,
  startDistancePx: number,
  currentDistancePx: number,
  minScale: number,
  maxScale: number,
): number {
  if (startDistancePx < 1 || currentDistancePx < 1) return startScale
  const raw = startScale * (currentDistancePx / startDistancePx)
  return Math.max(minScale, Math.min(maxScale, raw))
}

/** Metres of world space per CSS pixel at `viewDistanceM`, for a
 *  camera with the given vertical field of view. */
export function pixelsToWorldScale(
  viewDistanceM: number,
  fovYRad: number,
  viewportHeightPx: number,
): number {
  if (viewportHeightPx < 1) return 0
  const worldHeight = 2 * viewDistanceM * Math.tan(fovYRad / 2)
  return worldHeight / viewportHeightPx
}

/** World translation for a one-finger drag: the globe follows the
 *  finger, in the plane facing the camera. */
export function dragToWorld(
  dxPx: number,
  dyPx: number,
  worldPerPixel: number,
  right: Vec3Like,
  up: Vec3Like,
): Vec3Like {
  // Screen Y grows downward, world up grows upward — hence the sign.
  const along = dxPx * worldPerPixel
  const rise = -dyPx * worldPerPixel
  return {
    x: right.x * along + up.x * rise,
    y: right.y * along + up.y * rise,
    z: right.z * along + up.z * rise,
  }
}

/** Twist with the dead zone removed, smoothly: rotation starts from
 *  zero once the twist passes the zone rather than jumping by it. */
export function twistAfterDeadzone(radians: number, deadzoneRad: number): number {
  const magnitude = Math.abs(radians)
  if (magnitude <= deadzoneRad) return 0
  return Math.sign(radians) * (magnitude - deadzoneRad)
}

/** Wrap an angle into (-π, π]. */
function normalizeAngle(radians: number): number {
  let a = radians % (Math.PI * 2)
  if (a > Math.PI) a -= Math.PI * 2
  if (a <= -Math.PI) a += Math.PI * 2
  return a
}

function distance(a: TouchPoint, b: TouchPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function angle(a: TouchPoint, b: TouchPoint): number {
  return Math.atan2(b.y - a.y, b.x - a.x)
}

function sameIds(a: TouchPoint[], b: TouchPoint[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id) return false
  }
  return true
}

interface PinchBaseline {
  /** Finger separation when the pinch began — the ratio's denominator. */
  distancePx: number
  /** Globe scale when the pinch began — the ratio's numerator. */
  scale: number
  /** Separation angle at the previous event, for twist accumulation. */
  lastAngleRad: number
  /** Twist accumulated since the pinch began, wrapped per event so a
   *  full turn keeps counting instead of folding at ±π. */
  accumulatedRad: number
}

/**
 * Turn a stream of "all current touch points" snapshots into gesture
 * deltas.
 *
 * The tracker is **re-baselined whenever the set of fingers changes**
 * (a finger down, a finger up, or a different finger replacing one) and
 * reports nothing for that event. That is what stops the globe from
 * jumping when the second finger lands — the pinch starts from the
 * separation it actually has, and the move restarts from the finger's
 * current position.
 *
 * Only the first two points participate: a third finger must not
 * re-baseline the pinch, and phones have no gesture that needs it.
 */
export function createTouchGestureTracker() {
  let lastPoints: TouchPoint[] = []
  let pinch: PinchBaseline | null = null

  function reset(): void {
    lastPoints = []
    pinch = null
  }

  function update(points: TouchPoint[], ctx: TouchGestureContext): TouchGesture | null {
    const active = points.slice(0, 2)
    const previous = lastPoints.slice(0, 2)

    if (!sameIds(active, previous)) {
      lastPoints = active
      pinch =
        active.length >= 2
          ? {
              distancePx: distance(active[0], active[1]),
              scale: ctx.scale,
              lastAngleRad: angle(active[0], active[1]),
              accumulatedRad: 0,
            }
          : null
      return null
    }

    if (active.length === 0) return null

    if (active.length === 1) {
      const dxPx = active[0].x - previous[0].x
      const dyPx = active[0].y - previous[0].y
      lastPoints = active
      if (dxPx === 0 && dyPx === 0) return null
      return { kind: 'move', dxPx, dyPx }
    }

    const separation = distance(active[0], active[1])
    const orientation = angle(active[0], active[1])
    if (!pinch) {
      pinch = {
        distancePx: separation,
        scale: ctx.scale,
        lastAngleRad: orientation,
        accumulatedRad: 0,
      }
    }
    pinch.accumulatedRad += normalizeAngle(orientation - pinch.lastAngleRad)
    pinch.lastAngleRad = orientation
    const scale = pinchScale(
      pinch.scale,
      pinch.distancePx,
      separation,
      ctx.minScale,
      ctx.maxScale,
    )
    lastPoints = active
    return { kind: 'pinch', scale, rotationRad: pinch.accumulatedRad }
  }

  return { update, reset }
}
