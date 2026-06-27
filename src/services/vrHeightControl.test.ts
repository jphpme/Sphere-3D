import { describe, it, expect } from 'vitest'
import {
  HEIGHT_MAX,
  HEIGHT_MIN,
  HEIGHT_PITCH_RANGE,
  elevationToHeight,
  rayHeightAtPlane,
  rayPlaneXZ,
} from './vrHeightControl'

describe('elevationToHeight', () => {
  it('maps level gaze to the midpoint of the height range', () => {
    const mid = (HEIGHT_MIN + HEIGHT_MAX) / 2
    expect(elevationToHeight(0)).toBeCloseTo(mid, 6)
  })

  it('maps maximum upward pitch to HEIGHT_MAX', () => {
    expect(elevationToHeight(HEIGHT_PITCH_RANGE)).toBeCloseTo(HEIGHT_MAX, 6)
  })

  it('maps maximum downward pitch to HEIGHT_MIN', () => {
    expect(elevationToHeight(-HEIGHT_PITCH_RANGE)).toBeCloseTo(HEIGHT_MIN, 6)
  })

  it('clamps pitch beyond the configured band', () => {
    expect(elevationToHeight(HEIGHT_PITCH_RANGE + 0.5)).toBeCloseTo(HEIGHT_MAX, 6)
    expect(elevationToHeight(-HEIGHT_PITCH_RANGE - 0.5)).toBeCloseTo(HEIGHT_MIN, 6)
  })

  it('is monotonic in elevation', () => {
    const a = elevationToHeight(-0.1)
    const b = elevationToHeight(0)
    const c = elevationToHeight(0.1)
    expect(a).toBeLessThan(b)
    expect(b).toBeLessThan(c)
  })
})

describe('rayHeightAtPlane', () => {
  it('returns the distance for a ray pointing down at the floor', () => {
    // Eye at y=1.6 looking straight down (dirY = -1). Floor at y=0.
    expect(rayHeightAtPlane(1.6, -1, 0)).toBeCloseTo(1.6, 6)
  })

  it('returns null for a horizontal ray', () => {
    expect(rayHeightAtPlane(1.6, 0, 0)).toBeNull()
  })

  it('returns null when the crossing is behind the origin', () => {
    // Eye at y=1.6 looking up (dirY > 0): floor is below, behind the ray.
    expect(rayHeightAtPlane(1.6, 0.5, 0)).toBeNull()
  })

  it('handles a plane above the eye when looking up', () => {
    // Eye at y=0, looking up at a ceiling plane at y=2.
    expect(rayHeightAtPlane(0, 1, 2)).toBeCloseTo(2, 6)
  })
})

describe('rayPlaneXZ', () => {
  it('projects a downward gaze onto the floor XZ', () => {
    // Eye at (0, 1.6, 0) looking 45° forward-and-down.
    const dir = { x: 1, y: -1, z: 0 }
    const len = Math.hypot(dir.x, dir.y, dir.z)
    const unit = { x: dir.x / len, y: dir.y / len, z: dir.z / len }
    const hit = rayPlaneXZ({ x: 0, y: 1.6, z: 0 }, unit, 0)
    expect(hit).not.toBeNull()
    // Symmetric 45° down from height 1.6 lands at x = 1.6 on the floor.
    expect(hit!.x).toBeCloseTo(1.6, 5)
    expect(hit!.z).toBeCloseTo(0, 6)
  })

  it('returns null when the ray never crosses the plane ahead', () => {
    expect(rayPlaneXZ({ x: 0, y: 1.6, z: 0 }, { x: 0, y: 1, z: 0 }, 0)).toBeNull()
    expect(rayPlaneXZ({ x: 0, y: 1.6, z: 0 }, { x: 1, y: 0, z: 0 }, 0)).toBeNull()
  })
})
