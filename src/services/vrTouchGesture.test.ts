// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect } from 'vitest'
import {
  TWIST_DEADZONE_RAD,
  createTouchGestureTracker,
  dragToWorld,
  pinchScale,
  pixelsToWorldScale,
  twistAfterDeadzone,
  type TouchGestureContext,
} from './vrTouchGesture'

const CTX: TouchGestureContext = { scale: 1, minScale: 0.3, maxScale: 2.5 }

describe('pinchScale', () => {
  it('is the separation ratio applied to the starting scale', () => {
    expect(pinchScale(1, 100, 200, 0.3, 2.5)).toBeCloseTo(2)
    expect(pinchScale(1, 100, 50, 0.3, 2.5)).toBeCloseTo(0.5)
    expect(pinchScale(0.8, 250, 250, 0.3, 2.5)).toBeCloseTo(0.8)
  })

  it('clamps to the globe range', () => {
    expect(pinchScale(1, 10, 1000, 0.3, 2.5)).toBe(2.5)
    expect(pinchScale(1, 1000, 10, 0.3, 2.5)).toBe(0.3)
  })

  it('holds the starting scale when a separation is degenerate', () => {
    expect(pinchScale(1.4, 0, 120, 0.3, 2.5)).toBe(1.4)
    expect(pinchScale(1.4, 120, 0, 0.3, 2.5)).toBe(1.4)
  })
})

describe('pixelsToWorldScale', () => {
  it('is the viewport height at that distance divided by the pixel height', () => {
    // 90° vertical FOV at 2 m → 4 m tall; over a 1000 px viewport, 4 mm/px.
    expect(pixelsToWorldScale(2, Math.PI / 2, 1000)).toBeCloseTo(0.004)
  })

  it('grows linearly with distance', () => {
    expect(pixelsToWorldScale(4, Math.PI / 2, 1000)).toBeCloseTo(0.008)
  })

  it('is zero for a degenerate viewport', () => {
    expect(pixelsToWorldScale(2, Math.PI / 2, 0)).toBe(0)
  })
})

describe('dragToWorld', () => {
  const right = { x: 1, y: 0, z: 0 }
  const up = { x: 0, y: 1, z: 0 }

  it('moves the globe with the finger', () => {
    // Drag right → globe moves +X; drag down → globe moves -Y.
    expect(dragToWorld(10, 0, 0.01, right, up)).toEqual({ x: 0.1, y: 0, z: 0 })
    expect(dragToWorld(0, 10, 0.01, right, up).y).toBeCloseTo(-0.1)
  })

  it('follows a rotated camera basis', () => {
    // Camera yawed 90°: its right is world +Z.
    const yawedRight = { x: 0, y: 0, z: 1 }
    const delta = dragToWorld(10, 0, 0.01, yawedRight, up)
    expect(delta.x).toBeCloseTo(0)
    expect(delta.z).toBeCloseTo(0.1)
  })

  it('is a no-op for a still finger', () => {
    expect(dragToWorld(0, 0, 0.01, right, up)).toEqual({ x: 0, y: 0, z: 0 })
  })
})

describe('twistAfterDeadzone', () => {
  it('ignores drift inside the dead zone', () => {
    expect(twistAfterDeadzone(0, TWIST_DEADZONE_RAD)).toBe(0)
    expect(twistAfterDeadzone(TWIST_DEADZONE_RAD * 0.9, TWIST_DEADZONE_RAD)).toBe(0)
    expect(twistAfterDeadzone(-TWIST_DEADZONE_RAD * 0.9, TWIST_DEADZONE_RAD)).toBe(0)
  })

  it('starts from zero at the zone edge instead of jumping by it', () => {
    expect(twistAfterDeadzone(TWIST_DEADZONE_RAD, TWIST_DEADZONE_RAD)).toBe(0)
    expect(
      twistAfterDeadzone(TWIST_DEADZONE_RAD + 0.1, TWIST_DEADZONE_RAD),
    ).toBeCloseTo(0.1)
  })

  it('is symmetric for both twist directions', () => {
    expect(twistAfterDeadzone(-(TWIST_DEADZONE_RAD + 0.2), TWIST_DEADZONE_RAD)).toBeCloseTo(-0.2)
  })
})

describe('createTouchGestureTracker', () => {
  it('reports one-finger movement as a pixel delta', () => {
    const tracker = createTouchGestureTracker()
    tracker.update([{ id: 1, x: 100, y: 100 }], CTX)
    const gesture = tracker.update([{ id: 1, x: 130, y: 80 }], CTX)
    expect(gesture).toEqual({ kind: 'move', dxPx: 30, dyPx: -20 })
  })

  it('says nothing on the frame a second finger lands (re-baseline)', () => {
    const tracker = createTouchGestureTracker()
    tracker.update([{ id: 1, x: 100, y: 100 }], CTX)
    expect(
      tracker.update(
        [
          { id: 1, x: 100, y: 100 },
          { id: 2, x: 200, y: 100 },
        ],
        CTX,
      ),
    ).toBeNull()
  })

  it('scales from the separation the pinch started with', () => {
    const tracker = createTouchGestureTracker()
    tracker.update(
      [
        { id: 1, x: 100, y: 100 },
        { id: 2, x: 200, y: 100 },
      ],
      CTX,
    )
    const spread = tracker.update(
      [
        { id: 1, x: 50, y: 100 },
        { id: 2, x: 250, y: 100 },
      ],
      CTX,
    )
    expect(spread).toMatchObject({ kind: 'pinch', scale: 2 })

    const closed = tracker.update(
      [
        { id: 1, x: 125, y: 100 },
        { id: 2, x: 175, y: 100 },
      ],
      CTX,
    )
    // Still measured against the ORIGINAL 100 px separation — 50/100.
    expect(closed).toMatchObject({ kind: 'pinch', scale: 0.5 })
  })

  it('accumulates twist from the pinch baseline', () => {
    const tracker = createTouchGestureTracker()
    tracker.update(
      [
        { id: 1, x: 100, y: 100 },
        { id: 2, x: 200, y: 100 },
      ],
      CTX,
    )
    const rotated = tracker.update(
      [
        { id: 1, x: 100, y: 100 },
        { id: 2, x: 100, y: 200 },
      ],
      CTX,
    )
    expect(rotated?.kind).toBe('pinch')
    if (rotated?.kind === 'pinch') expect(rotated.rotationRad).toBeCloseTo(Math.PI / 2)
  })

  it('re-baselines when a finger lifts, so the globe does not jump', () => {
    const tracker = createTouchGestureTracker()
    tracker.update(
      [
        { id: 1, x: 100, y: 100 },
        { id: 2, x: 200, y: 100 },
      ],
      CTX,
    )
    expect(tracker.update([{ id: 1, x: 100, y: 100 }], CTX)).toBeNull()
    expect(tracker.update([{ id: 1, x: 110, y: 100 }], CTX)).toEqual({
      kind: 'move',
      dxPx: 10,
      dyPx: 0,
    })
  })

  it('ignores a third finger rather than re-baselining the pinch', () => {
    const tracker = createTouchGestureTracker()
    tracker.update(
      [
        { id: 1, x: 100, y: 100 },
        { id: 2, x: 200, y: 100 },
      ],
      CTX,
    )
    const gesture = tracker.update(
      [
        { id: 1, x: 100, y: 100 },
        { id: 2, x: 300, y: 100 },
        { id: 3, x: 500, y: 500 },
      ],
      CTX,
    )
    expect(gesture).toMatchObject({ kind: 'pinch', scale: 2 })
  })

  it('reports nothing for a still finger', () => {
    const tracker = createTouchGestureTracker()
    tracker.update([{ id: 1, x: 100, y: 100 }], CTX)
    expect(tracker.update([{ id: 1, x: 100, y: 100 }], CTX)).toBeNull()
  })

  it('forgets the baseline on reset', () => {
    const tracker = createTouchGestureTracker()
    tracker.update([{ id: 1, x: 100, y: 100 }], CTX)
    tracker.reset()
    expect(tracker.update([{ id: 1, x: 180, y: 100 }], CTX)).toBeNull()
  })
})
