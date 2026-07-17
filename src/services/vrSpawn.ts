/**
 * Headset-independent math for the VR gaze-based globe spawn.
 *
 * In immersive-vr and immersive-ar modes the globe no longer spawns
 * at a hardcoded world position (which assumed the user faced -Z at
 * session start). Instead, on the first XR frame with a valid viewer
 * pose, the globe is placed in front of wherever the user is actually
 * looking:
 *
 *   - the viewer's forward direction is projected onto the horizontal
 *     (XZ) plane, so looking up or down doesn't change the spawn
 *     distance or throw the globe into the floor / ceiling;
 *   - the globe sits {@link GAZE_SPAWN_DISTANCE} metres out along
 *     that projected direction;
 *   - the globe's height is the viewer's current eye height, so the
 *     spawn works standing and seated alike. In a `local` reference
 *     space (no floor) y=0 IS head height, so the same rule lands
 *     the globe at eye level there too.
 *
 * Everything in this file is pure arithmetic over plain numbers so
 * it can be unit-tested without a WebGL/WebXR context. The render
 * loop in {@link file://./vrSession.ts vrSession.ts} reads the
 * viewer pose on the first frame and feeds those numbers in here.
 */

/**
 * Distance in metres from the user's head to the spawned globe,
 * measured along the horizontal projection of their gaze. 1.4 m is
 * a touch closer than the legacy hardcoded spawn (1.5 m back along
 * -Z) so the globe feels "presented" to the user on entry rather
 * than at the far edge of arm's reach.
 */
export const GAZE_SPAWN_DISTANCE = 1.4

/**
 * Compute the globe spawn position from the viewer's initial pose.
 *
 * @param position    Viewer (head) position in reference-space coords.
 * @param orientation Viewer orientation as a quaternion — the head's
 *   forward axis is local -Z, per the WebXR viewer-pose convention.
 * @returns Globe center `{ x, y, z }` in the same coordinate space.
 */
export function computeGazeSpawnPosition(
  position: { x: number; y: number; z: number },
  orientation: { x: number; y: number; z: number; w: number },
): { x: number; y: number; z: number } {
  const { x: qx, y: qy, z: qz, w: qw } = orientation
  // Forward = orientation * (0, 0, -1), expanded so this file stays
  // free of a THREE dependency (kept unit-testable, same pattern as
  // vrHeightControl.ts).
  const fx = -2 * (qx * qz + qw * qy)
  const fz = 2 * (qx * qx + qy * qy) - 1

  // Project onto the horizontal plane and normalize.
  const len = Math.hypot(fx, fz)
  let dirX: number
  let dirZ: number
  if (len < 1e-5) {
    // Degenerate: user is looking straight up or down, so there is
    // no meaningful horizontal gaze direction. Fall back to the
    // legacy -Z spawn direction rather than NaN-ing the position.
    dirX = 0
    dirZ = -1
  } else {
    dirX = fx / len
    dirZ = fz / len
  }

  return {
    x: position.x + dirX * GAZE_SPAWN_DISTANCE,
    // Eye height verbatim — see the module docstring for why this
    // works in both `local-floor` and `local` reference spaces.
    y: position.y,
    z: position.z + dirZ * GAZE_SPAWN_DISTANCE,
  }
}
