// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import { HEARTBEAT_PERIOD_S, heartbeatScale } from './vrLoading'

describe('heartbeatScale', () => {
  // The same keyframes as `ayni-heartbeat` in loading.css, so the headset
  // splash and the 2D one beat together.
  const at = (fraction: number) => heartbeatScale(fraction * HEARTBEAT_PERIOD_S)

  it('beats twice, the first beat the stronger', () => {
    expect(at(0)).toBeCloseTo(1, 9)
    expect(at(0.14)).toBeCloseTo(1.12, 9)
    expect(at(0.28)).toBeCloseTo(1, 9)
    expect(at(0.42)).toBeCloseTo(1.07, 9)
  })

  it('rests between heartbeats', () => {
    for (const f of [0.6, 0.7, 0.85, 0.99]) expect(at(f)).toBeCloseTo(1, 9)
  })

  it('repeats every period, and never shrinks the mark', () => {
    expect(heartbeatScale(0.14 * HEARTBEAT_PERIOD_S + 3 * HEARTBEAT_PERIOD_S)).toBeCloseTo(1.12, 9)
    for (let t = 0; t < HEARTBEAT_PERIOD_S; t += 0.01) {
      expect(heartbeatScale(t)).toBeGreaterThanOrEqual(1 - 1e-9)
      expect(heartbeatScale(t)).toBeLessThanOrEqual(1.12 + 1e-9)
    }
  })
})
