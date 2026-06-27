/**
 * Headset-independent math for the two-step VR/AR placement height
 * control.
 *
 * The placement UX now has two sub-steps:
 *
 *   1. **position** — pick the globe's horizontal location. In AR
 *      this reuses the existing controller hit-test reticle against
 *      real surfaces. In VR (no real geometry) we project the
 *      headset's gaze ray onto a virtual floor plane.
 *   2. **height** — with the XZ location locked, the user tilts
 *      their head up/down to raise or lower the globe along the
 *      vertical axis, then triggers to confirm.
 *
 * Everything in this file is pure arithmetic over plain numbers so
 * it can be unit-tested without a WebGL/WebXR context. The render
 * loop in {@link file://./vrPlacement.ts vrPlacement.ts} reads the
 * headset pose each frame and feeds those numbers in here.
 */

/**
 * Lowest height (metres above the floor) the globe centre can be
 * placed at. Below this the globe bottom sinks into the floor even
 * at minimum zoom. Local-floor reference space puts y=0 at the
 * user's feet, so 0.3 m is roughly ankle height.
 */
export const HEIGHT_MIN = 0.3

/**
 * Highest height (metres above the floor). 2.0 m is above typical
 * eye height (~1.6 m standing), letting the user lift the globe up
 * to ceiling-ish level for an overhead view. Capped so the globe
 * can't fly out of the headset's tracking volume.
 */
export const HEIGHT_MAX = 2.0

/**
 * Headset pitch (elevation, radians) that maps to the full height
 * range. ±30° feels responsive without being twitchy — looking
 * straight ahead (0°) lands the globe at mid-height, glancing up
 * raises it, glancing down lowers it. Pitch outside this band is
 * clamped so the globe stops at the extremes rather than racing off.
 */
export const HEIGHT_PITCH_RANGE = Math.PI / 6 // 30°

/**
 * Map a headset elevation angle to a globe centre height in metres.
 *
 * Elevation is the pitch of the headset's forward direction:
 * positive = looking up, negative = looking down, 0 = level. The
 * ±{@link HEIGHT_PITCH_RANGE} band maps linearly onto
 * [{@link HEIGHT_MIN}, {@link HEIGHT_MAX}]. Outside the band the
 * result is clamped to the nearest endpoint.
 *
 * Linear mapping is deliberate: it gives the user a predictable
 * "tilt this much → move this much" feel. An exponential curve was
 * considered for finer control near the centre but tested as
 * unpredictable in quick head movements.
 *
 * @param elevationRad Headset pitch in radians (up positive).
 */
export function elevationToHeight(elevationRad: number): number {
  const clamped = Math.max(-HEIGHT_PITCH_RANGE, Math.min(HEIGHT_PITCH_RANGE, elevationRad))
  const t = (clamped + HEIGHT_PITCH_RANGE) / (2 * HEIGHT_PITCH_RANGE) // 0..1
  return HEIGHT_MIN + t * (HEIGHT_MAX - HEIGHT_MIN)
}

/**
 * Solve for the distance `t` along a ray at which it crosses a
 * horizontal plane, or `null` if it never does (ray parallel to
 * the plane, or the crossing is behind the ray origin).
 *
 * Used by VR gaze placement: the headset forward ray is intersected
 * with a virtual floor at `planeY` to find where the user is
 * "looking on the ground". The caller then computes the world XZ as
 * `origin + t * direction`.
 *
 * @param originY    Ray origin Y (headset eye height).
 * @param dirY       Ray direction Y component (unit ray: -1 = straight down).
 * @param planeY     Y coordinate of the horizontal plane to cross.
 * @returns Distance along the ray, or null if no forward crossing.
 */
export function rayHeightAtPlane(
  originY: number,
  dirY: number,
  planeY: number,
): number | null {
  // Direction horizontal → never crosses a horizontal plane.
  if (Math.abs(dirY) < 1e-5) return null
  const t = (planeY - originY) / dirY
  // Crossing behind the origin (or exactly at the eye) is not a
  // valid placement target — the user is looking up/level away from
  // the floor.
  if (t <= 0) return null
  return t
}

/**
 * Compute the world XZ point where a ray crosses a horizontal plane.
 *
 * Thin convenience wrapper over {@link rayHeightAtPlane}: returns
 * the crossing point's `{ x, z }`, or `null` when the ray doesn't
 * cross the plane ahead of the origin. Kept numeric (no THREE
 * dependency) so it stays unit-testable; callers wrap the result in
 * a Vector3 at the call site.
 *
 * @param origin  Ray origin `{ x, y, z }` (headset world position).
 * @param dir     Unit ray direction `{ x, y, z }` (headset forward).
 * @param planeY  Y coordinate of the floor plane to cross.
 */
export function rayPlaneXZ(
  origin: { x: number; y: number; z: number },
  dir: { x: number; y: number; z: number },
  planeY: number,
): { x: number; z: number } | null {
  const t = rayHeightAtPlane(origin.y, dir.y, planeY)
  if (t === null) return null
  return { x: origin.x + t * dir.x, z: origin.z + t * dir.z }
}
