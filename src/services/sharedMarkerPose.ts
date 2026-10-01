// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * AYNI — from the marker's corners in a camera frame to the marker's
 * place in the room: the frame of reference every device in a shared AR
 * session agrees on (`docs/SHARED_AR_PLAN.md`).
 *
 * The marker's printed size is never used. Each corner's line of sight is
 * intersected with the surface the device has already found under the
 * marker (the WebXR hit test), so a sheet of paper and a tablet of unknown
 * size give the same answer, and the measured size comes out as a result
 * (`MarkerFrame.size`), which is what makes a tape measure a test.
 *
 * The frame:
 *
 *   - origin: the middle of the marker;
 *   - +Y: up, away from the surface. On a table or floor this is snapped
 *     to the session's own up, so two devices cannot disagree by the tilt
 *     of their surface estimates;
 *   - +X: toward the marker's right edge as printed;
 *   - +Z: toward its bottom edge.
 *
 * Pure arithmetic over WebXR's own conventions (column-major matrices,
 * a camera looking down -Z): no DOM, no Three.js.
 */

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface Quat {
  x: number
  y: number
  z: number
  w: number
}

export interface Ray {
  origin: Vec3
  direction: Vec3
}

export interface Plane {
  point: Vec3
  normal: Vec3
}

export interface MarkerFrame {
  position: Vec3
  orientation: Quat
  /** Mean length of the black frame's sides, in metres. */
  size: number
}

/** A surface counts as level when its normal is within this of straight up. */
export const LEVEL_TOLERANCE_RADIANS = (20 * Math.PI) / 180

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
})
const length = (a: Vec3): number => Math.hypot(a.x, a.y, a.z)
function normalize(a: Vec3): Vec3 | null {
  const len = length(a)
  return len > 1e-9 ? { x: a.x / len, y: a.y / len, z: a.z / len } : null
}

/**
 * The line of sight through a point of the view, in the space the view's
 * pose is given in. `ndcX` / `ndcY` run -1..1, left to right and bottom to
 * top; `projection` is the view's projection matrix and `viewToWorld` its
 * transform's matrix.
 */
export function viewRay(
  ndcX: number,
  ndcY: number,
  projection: ArrayLike<number>,
  viewToWorld: ArrayLike<number>,
): Ray {
  // Undo the perspective projection at depth -1: x_ndc = P0·x - P8.
  const x = (ndcX + projection[8]) / projection[0]
  const y = (ndcY + projection[9]) / projection[5]
  const m = viewToWorld
  const direction = normalize({
    x: m[0] * x + m[4] * y - m[8],
    y: m[1] * x + m[5] * y - m[9],
    z: m[2] * x + m[6] * y - m[10],
  }) ?? { x: 0, y: 0, z: -1 }
  return { origin: { x: m[12], y: m[13], z: m[14] }, direction }
}

/** Where a ray meets a plane; null when it runs alongside or points away. */
export function intersectPlane(ray: Ray, plane: Plane): Vec3 | null {
  const facing = dot(ray.direction, plane.normal)
  if (Math.abs(facing) < 1e-6) return null
  const t = dot(sub(plane.point, ray.origin), plane.normal) / facing
  if (t <= 0) return null
  return {
    x: ray.origin.x + ray.direction.x * t,
    y: ray.origin.y + ray.direction.y * t,
    z: ray.origin.z + ray.direction.z * t,
  }
}

/** A direction turned by a rotation. */
export function rotateVector(q: Quat, v: Vec3): Vec3 {
  const u = { x: q.x, y: q.y, z: q.z }
  const t = cross(u, v)
  const t2 = { x: 2 * t.x, y: 2 * t.y, z: 2 * t.z }
  const c = cross(u, t2)
  return { x: v.x + q.w * t2.x + c.x, y: v.y + q.w * t2.y + c.y, z: v.z + q.w * t2.z + c.z }
}

/** The rotation whose columns are the given right-handed, orthonormal axes. */
export function quatFromAxes(x: Vec3, y: Vec3, z: Vec3): Quat {
  const trace = x.x + y.y + z.z
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1)
    return { w: 0.25 / s, x: (y.z - z.y) * s, y: (z.x - x.z) * s, z: (x.y - y.x) * s }
  }
  if (x.x > y.y && x.x > z.z) {
    const s = 2 * Math.sqrt(1 + x.x - y.y - z.z)
    return { w: (y.z - z.y) / s, x: 0.25 * s, y: (y.x + x.y) / s, z: (z.x + x.z) / s }
  }
  if (y.y > z.z) {
    const s = 2 * Math.sqrt(1 + y.y - x.x - z.z)
    return { w: (z.x - x.z) / s, x: (y.x + x.y) / s, y: 0.25 * s, z: (z.y + y.z) / s }
  }
  const s = 2 * Math.sqrt(1 + z.z - x.x - y.y)
  return { w: (x.y - y.x) / s, x: (z.x + x.z) / s, y: (z.y + y.z) / s, z: 0.25 * s }
}

/**
 * The marker's frame from its four corners in the room (top-left,
 * top-right, bottom-right, bottom-left) and the normal of the surface it
 * lies on. Null when the corners do not make a usable square.
 */
export function markerFrameFromCorners(
  corners: readonly [Vec3, Vec3, Vec3, Vec3],
  surfaceNormal: Vec3,
): MarkerFrame | null {
  const [tl, tr, br, bl] = corners
  let up = normalize(surfaceNormal)
  if (!up) return null
  // The normal of a table or floor, however it was estimated, means "up".
  if (up.y < 0) up = { x: -up.x, y: -up.y, z: -up.z }
  if (Math.acos(Math.min(1, up.y)) <= LEVEL_TOLERANCE_RADIANS) up = { x: 0, y: 1, z: 0 }
  // Right: from the middle of the left side to the middle of the right
  // side, laid flat against the surface.
  const across = sub(
    { x: (tr.x + br.x) / 2, y: (tr.y + br.y) / 2, z: (tr.z + br.z) / 2 },
    { x: (tl.x + bl.x) / 2, y: (tl.y + bl.y) / 2, z: (tl.z + bl.z) / 2 },
  )
  const lift = dot(across, up)
  const right = normalize({ x: across.x - up.x * lift, y: across.y - up.y * lift, z: across.z - up.z * lift })
  if (!right) return null
  const toward = cross(right, up)
  const sides = [length(sub(tr, tl)), length(sub(br, tr)), length(sub(bl, br)), length(sub(tl, bl))]
  const size = (sides[0] + sides[1] + sides[2] + sides[3]) / 4
  // Four sides of one square: a corner misread by the detector, or a
  // surface estimate far off the marker's own, shows as sides that differ.
  if (size < 1e-3 || Math.max(...sides) > 1.35 * Math.min(...sides)) return null
  return {
    position: {
      x: (tl.x + tr.x + br.x + bl.x) / 4,
      y: (tl.y + tr.y + br.y + bl.y) / 4,
      z: (tl.z + tr.z + br.z + bl.z) / 4,
    },
    orientation: quatFromAxes(right, up, toward),
    size,
  }
}

/** Most two readings of one still marker may differ in position, metres. */
export const STEADY_POSITION_M = 0.012
/** Most they may differ in heading. */
export const STEADY_HEADING_RADIANS = (2.5 * Math.PI) / 180

/**
 * One frame from several readings of a still marker: their mean, or null
 * when they disagree by more than a held phone's jitter (the phone or the
 * marker moved, or one reading was a misdetection).
 */
export function steadyMarkerFrame(readings: readonly MarkerFrame[]): MarkerFrame | null {
  if (readings.length === 0) return null
  const mean = { x: 0, y: 0, z: 0 }
  const right = { x: 0, y: 0, z: 0 }
  const up = { x: 0, y: 0, z: 0 }
  let size = 0
  const rights: Vec3[] = []
  for (const reading of readings) {
    mean.x += reading.position.x / readings.length
    mean.y += reading.position.y / readings.length
    mean.z += reading.position.z / readings.length
    const r = rotateVector(reading.orientation, { x: 1, y: 0, z: 0 })
    const u = rotateVector(reading.orientation, { x: 0, y: 1, z: 0 })
    rights.push(r)
    right.x += r.x
    right.y += r.y
    right.z += r.z
    up.x += u.x
    up.y += u.y
    up.z += u.z
    size += reading.size / readings.length
  }
  const meanUp = normalize(up)
  const meanRightRaw = normalize(right)
  if (!meanUp || !meanRightRaw) return null
  for (let i = 0; i < readings.length; i++) {
    if (length(sub(readings[i].position, mean)) > STEADY_POSITION_M) return null
    if (Math.acos(Math.min(1, dot(rights[i], meanRightRaw))) > STEADY_HEADING_RADIANS) return null
  }
  const lift = dot(meanRightRaw, meanUp)
  const meanRight = normalize({
    x: meanRightRaw.x - meanUp.x * lift,
    y: meanRightRaw.y - meanUp.y * lift,
    z: meanRightRaw.z - meanUp.z * lift,
  })
  if (!meanRight) return null
  return {
    position: mean,
    orientation: quatFromAxes(meanRight, meanUp, cross(meanRight, meanUp)),
    size,
  }
}
