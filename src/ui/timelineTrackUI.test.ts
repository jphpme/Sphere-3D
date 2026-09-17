// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTimelineTrackUI, type TimelineTrackUIHandle } from './timelineTrackUI'
import type { TimelineTrackState } from '../services/timelineTrackCanvas'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const START = Date.parse('2026-08-18T14:30:00Z')

const STATE: TimelineTrackState = {
  startMs: START,
  endMs: START + 30 * DAY,
  currentMs: START + 10 * DAY,
  frameCount: 2880,
  cadenceMs: 15 * MINUTE,
  availabilitySpans: [{ startFrame: 4, frameCount: 1, availability: 'filled' }],
  scrubbing: false,
}

/** Minimal 2D context — the module only paints through it. */
function fakeCtx() {
  return {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    fillText: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    measureText: vi.fn((text: string) => ({ width: text.length * 8 })),
    setTransform: vi.fn(),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
  } as unknown as CanvasRenderingContext2D
}

const handles: TimelineTrackUIHandle[] = []

function make(panelWidth = 240) {
  const onSeek = vi.fn()
  const handle = createTimelineTrackUI({ onSeek })
  document.body.appendChild(handle.element)
  // The module sizes itself from the container, which happy-dom reports as 0.
  Object.defineProperty(handle.element, 'clientWidth', {
    value: panelWidth,
    configurable: true,
  })
  const canvas = handle.element.querySelector('canvas')!
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: panelWidth, height: 56, right: panelWidth, bottom: 56, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
  handles.push(handle)
  return { handle, onSeek, canvas }
}

/** The bar's midpoint in client coordinates, from the same geometry the
 *  widget uses (3% inset, 94% width). */
function midBarX(panelWidth = 240): number {
  return 0.03 * panelWidth + (0.94 * panelWidth) / 2
}

function pointer(type: string, clientX: number): Event {
  return new MouseEvent(type, { clientX, bubbles: true, cancelable: true })
}

beforeEach(() => {
  document.body.innerHTML = ''
  HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(fakeCtx()) as unknown as typeof HTMLCanvasElement.prototype.getContext
})

afterEach(() => {
  for (const handle of handles.splice(0)) handle.dispose()
})

describe('createTimelineTrackUI', () => {
  it('starts hidden and is a named slider to assistive tech', () => {
    const { handle } = make()
    expect(handle.isVisible()).toBe(false)
    expect(handle.element.classList.contains('hidden')).toBe(true)
    expect(handle.element.getAttribute('role')).toBe('slider')
    expect(handle.element.getAttribute('aria-label')).toBeTruthy()
    expect(handle.element.getAttribute('aria-valuemin')).toBe('0')
  })

  it('shows the axis and reports the instant as the slider value', () => {
    const { handle, onSeek } = make()
    handle.setState(STATE)
    expect(handle.isVisible()).toBe(true)
    expect(handle.element.classList.contains('hidden')).toBe(false)
    expect(handle.element.getAttribute('aria-valuetext')).toContain('Aug')
    const now = Number(handle.element.getAttribute('aria-valuenow'))
    expect(now).toBeGreaterThan(0)
    expect(now).toBeLessThan(1000)
    expect(onSeek).not.toHaveBeenCalled()
  })

  it('seeks to the instant under a pointer press, and again on release', () => {
    const { handle, onSeek } = make()
    handle.setState(STATE)
    const x = midBarX()
    handle.element.dispatchEvent(pointer('pointerdown', x))
    expect(onSeek).toHaveBeenCalledTimes(1)
    const span = STATE.endMs - STATE.startMs
    expect(onSeek.mock.calls[0]![0]).toBeCloseTo(STATE.startMs + span * 0.5, -4)
    handle.element.dispatchEvent(pointer('pointerup', x))
    expect(onSeek).toHaveBeenCalledTimes(2)
  })

  it('ignores a press outside the axis', () => {
    const { handle, onSeek } = make()
    handle.setState(STATE)
    handle.element.dispatchEvent(pointer('pointerdown', 2))
    expect(onSeek).not.toHaveBeenCalled()
  })

  it('steps one frame with the arrows and jumps to the ends', () => {
    const { handle, onSeek } = make()
    handle.setState(STATE)
    handle.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(onSeek.mock.calls[0]![0]).toBe(STATE.currentMs + STATE.cadenceMs)
    onSeek.mockClear()
    handle.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    expect(onSeek.mock.calls[0]![0]).toBe(STATE.currentMs - STATE.cadenceMs)
    onSeek.mockClear()
    handle.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    expect(onSeek.mock.calls[0]![0]).toBe(STATE.startMs)
    onSeek.mockClear()
    handle.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    expect(onSeek.mock.calls[0]![0]).toBe(STATE.endMs - STATE.cadenceMs)
  })

  it('hides again when the axis goes away, and seeks nothing', () => {
    const { handle, onSeek } = make()
    handle.setState(STATE)
    handle.setState(null)
    expect(handle.isVisible()).toBe(false)
    handle.element.dispatchEvent(pointer('pointerdown', midBarX()))
    expect(onSeek).not.toHaveBeenCalled()
  })

  it('disposes its listeners and its element', () => {
    const { handle, onSeek } = make()
    handle.setState(STATE)
    handle.dispose()
    expect(handle.element.isConnected).toBe(false)
    handle.element.dispatchEvent(pointer('pointerdown', midBarX()))
    expect(onSeek).not.toHaveBeenCalled()
  })
})
