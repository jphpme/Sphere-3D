// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  intersectPlane,
  markerFrameFromCorners,
  quatFromAxes,
  rotateVector,
  steadyMarkerFrame,
  viewRay,
  type MarkerFrame,
  type Vec3,
} from './sharedMarkerPose'

/** A marker of `size` metres lying on a level surface at `centre`, its top
 *  edge turned `heading` radians about the vertical from pointing at -Z. */
function markerOnTable(centre: THREE.Vector3, size: number, heading: number) {
  const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading)
  const corner = (x: number, z: number) =>
    new THREE.Vector3(x * size / 2, 0, z * size / 2).applyQuaternion(turn).add(centre)
  // Top-left, top-right, bottom-right, bottom-left: +X right, +Z bottom.
  return [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)]
}

/** A phone camera at `position` looking at `target`. */
function phone(position: THREE.Vector3, target: THREE.Vector3) {
  const camera = new THREE.PerspectiveCamera(60, 9 / 16, 0.05, 20)
  camera.position.copy(position)
  camera.lookAt(target)
  camera.updateMatrixWorld()
  camera.updateProjectionMatrix()
  return camera
}

/** What the phone would compute: corners seen, rays cast, surface met. */
function frameSeenBy(camera: THREE.PerspectiveCamera, corners: THREE.Vector3[], surfaceY: number) {
  const plane = { point: { x: 0, y: surfaceY, z: 0 }, normal: { x: 0.02, y: 0.999, z: -0.03 } }
  const level = { point: plane.point, normal: { x: 0, y: 1, z: 0 } }
  const hits = corners.map((corner) => {
    const ndc = corner.clone().project(camera)
    const ray = viewRay(ndc.x, ndc.y, camera.projectionMatrix.elements, camera.matrixWorld.elements)
    return intersectPlane(ray, level)!
  })
  return markerFrameFromCorners(hits as [Vec3, Vec3, Vec3, Vec3], plane.normal)
}

describe('viewRay', () => {
  it('passes through the point it was projected from', () => {
    const camera = phone(new THREE.Vector3(0.4, 1.4, 0.9), new THREE.Vector3(0, 0.7, 0))
    const point = new THREE.Vector3(0.12, 0.7, -0.08)
    const ndc = point.clone().project(camera)
    const ray = viewRay(ndc.x, ndc.y, camera.projectionMatrix.elements, camera.matrixWorld.elements)
    expect(ray.origin.x).toBeCloseTo(0.4, 6)
    const toPoint = point.clone().sub(camera.position).normalize()
    expect(ray.direction.x).toBeCloseTo(toPoint.x, 5)
    expect(ray.direction.y).toBeCloseTo(toPoint.y, 5)
    expect(ray.direction.z).toBeCloseTo(toPoint.z, 5)
  })
})

describe('intersectPlane', () => {
  it('meets a table below and ignores one behind', () => {
    const table = { point: { x: 0, y: 0.7, z: 0 }, normal: { x: 0, y: 1, z: 0 } }
    const down = { origin: { x: 0, y: 1.7, z: 0 }, direction: { x: 0, y: -1, z: 0 } }
    expect(intersectPlane(down, table)).toEqual({ x: 0, y: 0.7, z: 0 })
    const up = { origin: down.origin, direction: { x: 0, y: 1, z: 0 } }
    expect(intersectPlane(up, table)).toBeNull()
    const level = { origin: down.origin, direction: { x: 1, y: 0, z: 0 } }
    expect(intersectPlane(level, table)).toBeNull()
  })
})

describe('quatFromAxes', () => {
  it('agrees with Three.js for a turned basis', () => {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, -2.1, 1.3))
    const axis = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyQuaternion(q)
    const mine = quatFromAxes(axis(1, 0, 0), axis(0, 1, 0), axis(0, 0, 1))
    // q and -q are the same rotation.
    const sign = Math.sign(mine.w) === Math.sign(q.w) ? 1 : -1
    expect(mine.x * sign).toBeCloseTo(q.x, 6)
    expect(mine.y * sign).toBeCloseTo(q.y, 6)
    expect(mine.z * sign).toBeCloseTo(q.z, 6)
    expect(mine.w * sign).toBeCloseTo(q.w, 6)
  })
})

describe('markerFrameFromCorners', () => {
  const centre = new THREE.Vector3(0.1, 0.72, -0.4)
  const corners = markerOnTable(centre, 0.16, 0.6)

  it('recovers the middle, the size and the heading', () => {
    const camera = phone(new THREE.Vector3(0.5, 1.3, 0.3), centre)
    const frame = frameSeenBy(camera, corners, centre.y)!
    expect(frame.position.x).toBeCloseTo(centre.x, 5)
    expect(frame.position.y).toBeCloseTo(centre.y, 5)
    expect(frame.position.z).toBeCloseTo(centre.z, 5)
    expect(frame.size).toBeCloseTo(0.16, 5)
    const right = rotateVector(frame.orientation, { x: 1, y: 0, z: 0 })
    expect(right.x).toBeCloseTo(Math.cos(0.6), 5)
    expect(right.z).toBeCloseTo(-Math.sin(0.6), 5)
    // A nearly-level surface estimate is snapped to straight up.
    expect(rotateVector(frame.orientation, { x: 0, y: 1, z: 0 }).y).toBeCloseTo(1, 9)
  })

  it('gives two phones on opposite sides of the table the same frame', () => {
    const one = frameSeenBy(phone(new THREE.Vector3(0.6, 1.2, 0.2), centre), corners, centre.y)!
    const two = frameSeenBy(phone(new THREE.Vector3(-0.5, 1.5, -1.1), centre), corners, centre.y)!
    expect(two.position.x).toBeCloseTo(one.position.x, 5)
    expect(two.position.z).toBeCloseTo(one.position.z, 5)
    const a = rotateVector(one.orientation, { x: 1, y: 0, z: 0 })
    const b = rotateVector(two.orientation, { x: 1, y: 0, z: 0 })
    expect(a.x * b.x + a.y * b.y + a.z * b.z).toBeCloseTo(1, 8)
  })

  it('points +Z at the bottom edge of the marker', () => {
    const frame = frameSeenBy(phone(new THREE.Vector3(0.5, 1.3, 0.3), centre), corners, centre.y)!
    const toward = rotateVector(frame.orientation, { x: 0, y: 0, z: 1 })
    const bottom = corners[2].clone().add(corners[3]).multiplyScalar(0.5).sub(centre).normalize()
    expect(toward.x).toBeCloseTo(bottom.x, 5)
    expect(toward.z).toBeCloseTo(bottom.z, 5)
  })

  it('refuses corners that do not make a square', () => {
    const bent = corners.map((c) => ({ x: c.x, y: c.y, z: c.z })) as [Vec3, Vec3, Vec3, Vec3]
    bent[1] = { x: bent[1].x + 0.2, y: bent[1].y, z: bent[1].z }
    expect(markerFrameFromCorners(bent, { x: 0, y: 1, z: 0 })).toBeNull()
  })
})

describe('steadyMarkerFrame', () => {
  const reading = (dx: number, heading: number): MarkerFrame => ({
    position: { x: dx, y: 0.7, z: 0 },
    orientation: quatFromAxes(
      { x: Math.cos(heading), y: 0, z: -Math.sin(heading) },
      { x: 0, y: 1, z: 0 },
      { x: Math.sin(heading), y: 0, z: Math.cos(heading) },
    ),
    size: 0.16,
  })

  it('averages readings that agree', () => {
    const frame = steadyMarkerFrame([reading(0, 0.01), reading(0.004, -0.01), reading(0.002, 0)])!
    expect(frame.position.x).toBeCloseTo(0.002, 6)
    expect(rotateVector(frame.orientation, { x: 1, y: 0, z: 0 }).z).toBeCloseTo(0, 4)
    expect(frame.size).toBeCloseTo(0.16, 9)
  })

  it('refuses readings that moved or turned between frames', () => {
    expect(steadyMarkerFrame([reading(0, 0), reading(0.05, 0), reading(0, 0)])).toBeNull()
    expect(steadyMarkerFrame([reading(0, 0), reading(0, 0.2), reading(0, 0)])).toBeNull()
    expect(steadyMarkerFrame([])).toBeNull()
  })
})
