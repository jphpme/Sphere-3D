import { describe, it, expect } from 'vitest'
import { computeGazeSpawnPosition, GAZE_SPAWN_DISTANCE } from './vrSpawn'

/** Quaternion for a yaw of `rad` about the +Y axis (turning left is positive). */
function yaw(rad: number): { x: number; y: number; z: number; w: number } {
  return { x: 0, y: Math.sin(rad / 2), z: 0, w: Math.cos(rad / 2) }
}

/** Quaternion for a pitch of `rad` about the +X axis (looking up is positive). */
function pitch(rad: number): { x: number; y: number; z: number; w: number } {
  return { x: Math.sin(rad / 2), y: 0, z: 0, w: Math.cos(rad / 2) }
}

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 }

describe('computeGazeSpawnPosition', () => {
  it('places the globe GAZE_SPAWN_DISTANCE ahead along -Z for a level forward gaze', () => {
    const spawn = computeGazeSpawnPosition({ x: 0, y: 1.6, z: 0 }, IDENTITY)
    expect(spawn.x).toBeCloseTo(0)
    expect(spawn.y).toBeCloseTo(1.6)
    expect(spawn.z).toBeCloseTo(-GAZE_SPAWN_DISTANCE)
  })

  it('follows the user\'s yaw instead of assuming -Z', () => {
    // Turned 90° left — forward is world -X.
    const left = computeGazeSpawnPosition({ x: 0, y: 1.6, z: 0 }, yaw(Math.PI / 2))
    expect(left.x).toBeCloseTo(-GAZE_SPAWN_DISTANCE)
    expect(left.z).toBeCloseTo(0)
    // Turned 90° right — forward is world +X.
    const right = computeGazeSpawnPosition({ x: 0, y: 1.6, z: 0 }, yaw(-Math.PI / 2))
    expect(right.x).toBeCloseTo(GAZE_SPAWN_DISTANCE)
    expect(right.z).toBeCloseTo(0)
  })

  it('projects pitch away — looking down keeps the horizontal distance and eye height', () => {
    // Head at origin, pitched 45° down. Legacy behaviour would have
    // sunk the globe toward the floor; the spawn must stay level.
    const spawn = computeGazeSpawnPosition({ x: 0, y: 1.2, z: 0 }, pitch(-Math.PI / 4))
    expect(spawn.y).toBeCloseTo(1.2)
    const horizontalDistance = Math.hypot(spawn.x, spawn.z)
    expect(horizontalDistance).toBeCloseTo(GAZE_SPAWN_DISTANCE)
  })

  it('keeps the head\'s world XZ as the spawn anchor', () => {
    const spawn = computeGazeSpawnPosition({ x: 2, y: 1.4, z: 3 }, IDENTITY)
    expect(spawn.x).toBeCloseTo(2)
    expect(spawn.z).toBeCloseTo(3 - GAZE_SPAWN_DISTANCE)
  })

  it('falls back to -Z when the user looks straight down (degenerate horizontal projection)', () => {
    const spawn = computeGazeSpawnPosition({ x: 1, y: 1.5, z: 1 }, pitch(-Math.PI / 2))
    expect(spawn.x).toBeCloseTo(1)
    expect(spawn.y).toBeCloseTo(1.5)
    expect(spawn.z).toBeCloseTo(1 - GAZE_SPAWN_DISTANCE)
  })

  it('spawns at y=0 (head height) in a local reference space where the origin is the head', () => {
    const spawn = computeGazeSpawnPosition({ x: 0, y: 0, z: 0 }, IDENTITY)
    expect(spawn.y).toBe(0)
  })
})
