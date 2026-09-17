// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  emitVrInteraction,
  thumbstickAxisY,
  __resetVrInteractionThrottleForTests,
  VR_INTERACTION_MAX_PER_MINUTE,
} from './vrInteraction'
import { resetForTests, __peek, setTransport } from '../analytics/emitter'
import { setTier } from '../analytics/config'
import type { TelemetryEvent } from '../types'
import type { Transport } from '../analytics/transport'

/** Capturing transport that records every event handed to flush so
 * the test can assert against the cumulative emit count even when
 * BATCH_SIZE-driven auto-flushes drain the in-memory queue. */
function captureTransport(): { sent: TelemetryEvent[]; transport: Transport } {
  const sent: TelemetryEvent[] = []
  const transport: Transport = {
    endpoint: 'test://capture',
    async send(_sessionId, events) {
      sent.push(...events)
      return { ok: true, retryable: false, permanent: false, status: 204 }
    },
    sendBeacon(_sessionId, events) {
      sent.push(...events)
      return true
    },
  }
  return { sent, transport }
}

beforeEach(() => {
  localStorage.clear()
  resetForTests()
  __resetVrInteractionThrottleForTests()
  setTier('research')
})

afterEach(() => {
  __resetVrInteractionThrottleForTests()
  vi.restoreAllMocks()
})

describe('emitVrInteraction — Tier-B vr_interaction emit', () => {
  it('emits a vr_interaction event with the gesture and rounded magnitude', () => {
    emitVrInteraction('drag', 1.234567)
    const events = __peek().filter((e) => e.event_type === 'vr_interaction')
    expect(events).toHaveLength(1)
    const e = events[0]
    if (e.event_type !== 'vr_interaction') throw new Error('unreachable')
    expect(e.gesture).toBe('drag')
    expect(e.magnitude).toBe(1.23)
  })

  it('drops the event when the tier is below research', () => {
    setTier('essential')
    emitVrInteraction('drag', 1)
    expect(__peek().filter((e) => e.event_type === 'vr_interaction')).toHaveLength(0)
    setTier('off')
    emitVrInteraction('drag', 1)
    expect(__peek().filter((e) => e.event_type === 'vr_interaction')).toHaveLength(0)
  })

  it('rounds magnitude to 2 decimals', () => {
    emitVrInteraction('thumbstick_zoom', 0.999)
    const e = __peek().find((x) => x.event_type === 'vr_interaction')
    if (!e || e.event_type !== 'vr_interaction') throw new Error('unreachable')
    expect(e.magnitude).toBe(1)
  })
})

describe('emitVrInteraction — per-gesture throttle', () => {
  it('caps each gesture at VR_INTERACTION_MAX_PER_MINUTE per minute', async () => {
    const { sent, transport } = captureTransport()
    setTransport(transport)
    const base = 1_700_000_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(base)
    for (let i = 0; i < VR_INTERACTION_MAX_PER_MINUTE + 5; i++) {
      emitVrInteraction('drag', 0.1)
    }
    // Drain the residual queue into the capture transport.
    const { flush } = await import('../analytics/emitter')
    flush()
    const dragEvents = sent.filter(
      (e) => e.event_type === 'vr_interaction' && e.gesture === 'drag',
    )
    expect(dragEvents).toHaveLength(VR_INTERACTION_MAX_PER_MINUTE)
    nowSpy.mockRestore()
  })

  it('throttles each gesture independently', async () => {
    const { sent, transport } = captureTransport()
    setTransport(transport)
    const base = 1_700_000_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(base)
    for (let i = 0; i < VR_INTERACTION_MAX_PER_MINUTE + 3; i++) {
      emitVrInteraction('drag', 0.1)
    }
    emitVrInteraction('pinch', 0.5)
    const { flush } = await import('../analytics/emitter')
    flush()
    const dragEvents = sent.filter(
      (e) => e.event_type === 'vr_interaction' && e.gesture === 'drag',
    )
    const pinchEvents = sent.filter(
      (e) => e.event_type === 'vr_interaction' && e.gesture === 'pinch',
    )
    expect(dragEvents).toHaveLength(VR_INTERACTION_MAX_PER_MINUTE)
    expect(pinchEvents).toHaveLength(1)
    nowSpy.mockRestore()
  })

  it('admits new events after the window slides forward', async () => {
    const { sent, transport } = captureTransport()
    setTransport(transport)
    const base = 1_700_000_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(base)
    for (let i = 0; i < VR_INTERACTION_MAX_PER_MINUTE; i++) {
      emitVrInteraction('hud_tap', 1)
    }
    // One more inside the window — dropped.
    emitVrInteraction('hud_tap', 1)
    // Slide the clock forward past the window; throttle entries age out.
    nowSpy.mockReturnValue(base + 61_000)
    emitVrInteraction('hud_tap', 1)
    const { flush } = await import('../analytics/emitter')
    flush()
    const hudEvents = sent.filter(
      (e) => e.event_type === 'vr_interaction' && e.gesture === 'hud_tap',
    )
    expect(hudEvents).toHaveLength(VR_INTERACTION_MAX_PER_MINUTE + 1)
    nowSpy.mockRestore()
  })
})

describe('thumbstickAxisY — which sources may drive the zoom', () => {
  const controller = (axes: number[], withGamepad = true) => ({
    targetRayMode: 'tracked-pointer',
    gamepad: withGamepad ? { axes } : null,
  })

  it('reads axes[3] from a controller, falling back to axes[1]', () => {
    expect(thumbstickAxisY(controller([0, 0, 0, -0.8]))).toBe(-0.8)
    // A pad that reports only the touchpad pair still works.
    expect(thumbstickAxisY(controller([0, 0.7]))).toBe(0.7)
  })

  it('refuses a screen source whose gamepad carries the touch position', () => {
    // The Chrome-on-Android shape: axes are the finger's x/y. Reading
    // them as a stick is what resized the globe on every press.
    expect(
      thumbstickAxisY({ targetRayMode: 'screen', gamepad: { axes: [0.4, 0.9] } }),
    ).toBeNull()
  })

  it('refuses transient-pointer and gaze sources', () => {
    expect(
      thumbstickAxisY({ targetRayMode: 'transient-pointer', gamepad: { axes: [0, 1] } }),
    ).toBeNull()
    expect(
      thumbstickAxisY({ targetRayMode: 'gaze', gamepad: { axes: [0, 1] } }),
    ).toBeNull()
  })

  it('is null for a missing source, a missing gamepad, and a non-finite axis', () => {
    expect(thumbstickAxisY(null)).toBeNull()
    expect(thumbstickAxisY(undefined)).toBeNull()
    expect(thumbstickAxisY(controller([0, 0.5], false))).toBeNull()
    expect(thumbstickAxisY({ targetRayMode: 'tracked-pointer' })).toBeNull()
    // NaN used to slip past the deadzone check (Math.abs(NaN) <= x is false).
    expect(thumbstickAxisY(controller([0, 0, 0, Number.NaN]))).toBeNull()
  })

  it('returns the raw reading — the deadzone stays in the caller', () => {
    expect(thumbstickAxisY(controller([0, 0, 0, 0.05]))).toBe(0.05)
  })
})
