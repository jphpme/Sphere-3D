// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  RADIANS_PER_SCREEN_HEIGHT,
  RADIANS_PER_SCREEN_WIDTH,
  ROTATE_DRAG_THRESHOLD_PX,
  createVrRotateTouch,
  dragToRotation,
  dragToTilt,
} from './vrRotateTouch'

/** Build a TouchEvent-shaped object that the handlers can read. The
 *  capture-phase window listeners see the dispatched event directly,
 *  so a plain Event with the touch lists bolted on is enough. */
function touchEvent(
  type: string,
  touches: Array<{ id: number; x: number; y?: number }>,
  target: EventTarget = document.body,
): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true })
  const list = touches.map((t) => ({
    identifier: t.id,
    clientX: t.x,
    clientY: t.y ?? 0,
  }))
  Object.defineProperty(ev, 'changedTouches', { value: list })
  Object.defineProperty(ev, 'touches', { value: list })
  Object.defineProperty(ev, 'target', { value: target })
  return ev
}

function fire(
  type: string,
  touches: Array<{ id: number; x: number; y?: number }>,
  target?: EventTarget,
): void {
  window.dispatchEvent(touchEvent(type, touches, target))
}

describe('dragToRotation', () => {
  it('maps a full screen width of travel to one revolution', () => {
    expect(dragToRotation(1000, 1000)).toBeCloseTo(RADIANS_PER_SCREEN_WIDTH)
    expect(dragToRotation(-500, 1000)).toBeCloseTo(-RADIANS_PER_SCREEN_WIDTH / 2)
  })

  it('returns 0 for a degenerate screen width', () => {
    expect(dragToRotation(100, 0)).toBe(0)
    expect(dragToRotation(100, Number.NaN)).toBe(0)
  })
})

describe('vrRotateTouch', () => {
  const handles: Array<{ dispose(): void }> = []
  afterEach(() => {
    for (const h of handles.splice(0)) h.dispose()
    document.body.innerHTML = ''
  })

  function make(enabled = true) {
    const onRotate = vi.fn()
    const handle = createVrRotateTouch({ onRotate })
    handle.setEnabled(enabled)
    handles.push(handle)
    return { handle, onRotate }
  }

  it('one finger dragged sideways rotates by the travel past the threshold', () => {
    const { onRotate } = make()
    fire('touchstart', [{ id: 1, x: 100 }])
    fire('touchmove', [{ id: 1, x: 100 + ROTATE_DRAG_THRESHOLD_PX }])
    // Crossing the threshold re-baselines; no jump by the dead zone.
    expect(onRotate).not.toHaveBeenCalled()
    fire('touchmove', [{ id: 1, x: 100 + ROTATE_DRAG_THRESHOLD_PX + 50 }])
    expect(onRotate).toHaveBeenCalledTimes(1)
    expect(onRotate).toHaveBeenLastCalledWith(dragToRotation(50, window.innerWidth))
  })

  it('a tap (no travel) rotates nothing', () => {
    const { onRotate } = make()
    fire('touchstart', [{ id: 1, x: 100 }])
    fire('touchmove', [{ id: 1, x: 103 }])
    fire('touchend', [{ id: 1, x: 103 }])
    expect(onRotate).not.toHaveBeenCalled()
  })

  it('vertical travel alone rotates nothing', () => {
    const { onRotate } = make()
    fire('touchstart', [{ id: 1, x: 100, y: 100 }])
    fire('touchmove', [{ id: 1, x: 100, y: 400 }])
    expect(onRotate).not.toHaveBeenCalled()
  })

  it('a second finger is ignored entirely', () => {
    const { onRotate } = make()
    fire('touchstart', [{ id: 1, x: 100 }])
    fire('touchstart', [{ id: 2, x: 300 }])
    // Second finger moves a lot — nothing happens.
    fire('touchmove', [{ id: 2, x: 600 }])
    expect(onRotate).not.toHaveBeenCalled()
    // First finger still drives rotation (first move past the dead
    // zone only re-baselines; the next one rotates).
    fire('touchmove', [{ id: 1, x: 200 }])
    fire('touchmove', [{ id: 1, x: 230 }])
    expect(onRotate).toHaveBeenCalledTimes(1)
    // Lifting the second finger does not end the first's drag.
    fire('touchend', [{ id: 2, x: 600 }])
    fire('touchmove', [{ id: 1, x: 260 }])
    expect(onRotate).toHaveBeenCalledTimes(2)
  })

  it('does nothing while disabled', () => {
    const { onRotate } = make(false)
    fire('touchstart', [{ id: 1, x: 100 }])
    fire('touchmove', [{ id: 1, x: 400 }])
    expect(onRotate).not.toHaveBeenCalled()
  })

  it('disabling mid-drag forgets the finger', () => {
    const { handle, onRotate } = make()
    fire('touchstart', [{ id: 1, x: 100 }])
    handle.setEnabled(false)
    handle.setEnabled(true)
    fire('touchmove', [{ id: 1, x: 400 }])
    expect(onRotate).not.toHaveBeenCalled()
  })

  it('touches that start on a DOM control are left to the control', () => {
    const { onRotate } = make()
    const button = document.createElement('button')
    document.body.appendChild(button)
    fire('touchstart', [{ id: 1, x: 100 }], button)
    fire('touchmove', [{ id: 1, x: 400 }], button)
    expect(onRotate).not.toHaveBeenCalled()
  })

  it('dispose() removes the listeners', () => {
    const { handle, onRotate } = make()
    handle.dispose()
    fire('touchstart', [{ id: 1, x: 100 }])
    fire('touchmove', [{ id: 1, x: 400 }])
    expect(onRotate).not.toHaveBeenCalled()
  })
})

describe('AYNI — tilt from the same drag', () => {
  const handles: Array<{ dispose(): void }> = []
  afterEach(() => {
    for (const h of handles.splice(0)) h.dispose()
  })

  function make() {
    const onRotate = vi.fn()
    const onTilt = vi.fn()
    const handle = createVrRotateTouch({ onRotate, onTilt })
    handle.setEnabled(true)
    handles.push(handle)
    return { onRotate, onTilt }
  }

  it('maps a full screen height of travel to half a turn', () => {
    expect(dragToTilt(800, 800)).toBeCloseTo(RADIANS_PER_SCREEN_HEIGHT)
    expect(dragToTilt(-400, 800)).toBeCloseTo(-Math.PI / 2)
    expect(dragToTilt(100, 0)).toBe(0)
  })

  it('a vertical drag tilts, and is a drag as readily as a sideways one', () => {
    const { onRotate, onTilt } = make()
    fire('touchstart', [{ id: 1, x: 100, y: 100 }])
    fire('touchmove', [{ id: 1, x: 100, y: 100 + ROTATE_DRAG_THRESHOLD_PX }])
    fire('touchmove', [{ id: 1, x: 100, y: 100 + ROTATE_DRAG_THRESHOLD_PX + 60 }])
    // Downward travel is positive: the globe's top comes toward the viewer.
    expect(onTilt).toHaveBeenLastCalledWith(dragToTilt(60, window.innerHeight))
    expect(onRotate).not.toHaveBeenCalled()
  })

  it('a diagonal drag spins and tilts at once, each by its own axis of travel', () => {
    const { onRotate, onTilt } = make()
    fire('touchstart', [{ id: 1, x: 100, y: 100 }])
    fire('touchmove', [{ id: 1, x: 120, y: 120 }])
    fire('touchmove', [{ id: 1, x: 170, y: 90 }])
    expect(onRotate).toHaveBeenLastCalledWith(dragToRotation(50, window.innerWidth))
    expect(onTilt).toHaveBeenLastCalledWith(dragToTilt(-30, window.innerHeight))
  })

  it('a second finger still does nothing', () => {
    const { onRotate, onTilt } = make()
    fire('touchstart', [{ id: 1, x: 100, y: 100 }])
    fire('touchstart', [{ id: 2, x: 300, y: 300 }])
    fire('touchmove', [{ id: 2, x: 300, y: 500 }])
    expect(onTilt).not.toHaveBeenCalled()
    expect(onRotate).not.toHaveBeenCalled()
  })
})
