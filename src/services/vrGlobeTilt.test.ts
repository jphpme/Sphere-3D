// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { MAX_TILT_RADIANS, tiltGlobe } from './vrGlobeTilt'

/** The globe at the origin, a camera 1.5 m in front of it looking at it. */
function scene() {
  const globe = new THREE.Object3D()
  const camera = new THREE.PerspectiveCamera()
  camera.position.set(0, 0, 1.5)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld()
  return { globe, camera }
}

/** Where the globe's north pole points, in world space. */
const pole = (globe: THREE.Object3D) => new THREE.Vector3(0, 1, 0).applyQuaternion(globe.getWorldQuaternion(new THREE.Quaternion()))

describe('tiltGlobe', () => {
  it('brings the top of the globe toward the viewer for a downward drag', () => {
    const { globe, camera } = scene()
    expect(tiltGlobe(THREE, globe, camera, Math.PI / 6)).toBe(true)
    const p = pole(globe)
    expect(p.z).toBeCloseTo(Math.sin(Math.PI / 6), 6) // toward the camera at +z
    expect(p.y).toBeCloseTo(Math.cos(Math.PI / 6), 6)
    expect(p.x).toBeCloseTo(0, 6)
  })

  it('tilts about the line across the view, not the phone\'s roll', () => {
    const { globe, camera } = scene()
    camera.rotateZ(Math.PI / 5) // phone held at an angle
    camera.updateMatrixWorld()
    tiltGlobe(THREE, globe, camera, Math.PI / 6)
    expect(pole(globe).x).toBeCloseTo(0, 6)
  })

  it('stops before the globe turns upside down, but always lets it come back', () => {
    const { globe, camera } = scene()
    for (let i = 0; i < 40; i++) tiltGlobe(THREE, globe, camera, 0.1)
    const lean = pole(globe).angleTo(new THREE.Vector3(0, 1, 0))
    expect(lean).toBeLessThanOrEqual(MAX_TILT_RADIANS + 1e-9)
    expect(lean).toBeGreaterThan(MAX_TILT_RADIANS - 0.1)
    expect(tiltGlobe(THREE, globe, camera, 0.1)).toBe(false)
    expect(tiltGlobe(THREE, globe, camera, -0.1)).toBe(true)
  })

  it('keeps a later spin about the globe\'s own, tilted, axis', () => {
    const { globe, camera } = scene()
    tiltGlobe(THREE, globe, camera, Math.PI / 4)
    const before = pole(globe)
    globe.rotateY(1.2) // what the sideways drag does
    expect(pole(globe).distanceTo(before)).toBeCloseTo(0, 6)
  })

  it('works under a rotated parent, as a placed globe may be', () => {
    const { globe, camera } = scene()
    const anchor = new THREE.Object3D()
    anchor.rotation.y = Math.PI / 2
    anchor.add(globe)
    anchor.updateMatrixWorld()
    tiltGlobe(THREE, globe, camera, Math.PI / 6)
    expect(pole(globe).z).toBeCloseTo(Math.sin(Math.PI / 6), 6)
    expect(pole(globe).x).toBeCloseTo(0, 6)
  })

  it('does nothing when the view has no horizontal line across it, or for no movement', () => {
    const { globe, camera } = scene()
    camera.rotateZ(Math.PI / 2) // rolled a quarter turn: its right vector points straight up
    camera.updateMatrixWorld()
    expect(tiltGlobe(THREE, globe, camera, 0.3)).toBe(false)
    expect(globe.quaternion.equals(new THREE.Quaternion())).toBe(true)
    expect(tiltGlobe(THREE, globe, scene().camera, 0)).toBe(false)
  })
})
