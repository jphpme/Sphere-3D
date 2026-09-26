// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * AYNI — tilting the immersive globe toward or away from the viewer, for
 * the handheld AR drag (vrRotateTouch's vertical travel).
 *
 * The tilt axis is the horizontal line across the viewer's line of sight:
 * the camera's right vector with its vertical part removed. So a phone
 * held at an angle still tilts the globe the way the finger moves across
 * the screen, not along the phone's own roll. It is applied in the
 * globe's parent frame, because a placed globe may sit under a rotated
 * anchor, and before the globe's own rotation, so a later spin still
 * turns the globe about its own (now tilted) polar axis.
 *
 * Bounded: the globe's polar axis may lean at most MAX_TILT_RADIANS from
 * upright, so it can never end up upside down. A move that would lean it
 * further is refused, while one back toward upright is always allowed,
 * so a globe that starts outside the bound is never stuck.
 */

import type * as THREE from 'three'

/** How far the polar axis may lean from upright: 80°. */
export const MAX_TILT_RADIANS = (80 * Math.PI) / 180

/**
 * Tilt `globe` by `angle` radians about the horizontal axis across
 * `camera`'s view. Positive brings the globe's top toward the viewer.
 * Returns whether the tilt was applied.
 */
export function tiltGlobe(
  THREE_: typeof THREE,
  globe: THREE.Object3D,
  camera: THREE.Object3D,
  angle: number,
): boolean {
  if (!Number.isFinite(angle) || angle === 0) return false
  const up = new THREE_.Vector3(0, 1, 0)

  const cameraQ = camera.getWorldQuaternion(new THREE_.Quaternion())
  const right = new THREE_.Vector3(1, 0, 0).applyQuaternion(cameraQ)
  right.y = 0
  // Looking straight down: no horizontal line across the view to tilt about.
  if (right.lengthSq() < 1e-6) return false
  right.normalize()

  const parentQ = globe.parent
    ? globe.parent.getWorldQuaternion(new THREE_.Quaternion())
    : new THREE_.Quaternion()
  const axisInParent = right.clone().applyQuaternion(parentQ.clone().invert())
  const next = new THREE_.Quaternion()
    .setFromAxisAngle(axisInParent, angle)
    .multiply(globe.quaternion)

  const leanOf = (q: THREE.Quaternion) =>
    new THREE_.Vector3(0, 1, 0).applyQuaternion(parentQ.clone().multiply(q)).angleTo(up)
  const before = leanOf(globe.quaternion)
  const after = leanOf(next)
  if (after > MAX_TILT_RADIANS && after > before) return false

  globe.quaternion.copy(next)
  return true
}
