// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import { clearBottomOffset, type Box } from './timeLabelPosition'

/** A 106 x 32 label centred in a container `width` wide. */
const label = (width: number) => ({ left: width / 2 - 53, right: width / 2 + 53, height: 32 })
const MARGIN = 12
const GAP = 6

describe('clearBottomOffset', () => {
  it('rests at the margin when the middle of the bottom edge is free', () => {
    // A desktop: info panel at the left, playback bar at the right.
    const obstacles: Box[] = [
      { left: 12, right: 352, top: 721, bottom: 756 },
      { left: 1033, right: 1354, top: 632, bottom: 756 },
    ]
    expect(clearBottomOffset(768, label(1366), obstacles, MARGIN, GAP)).toBe(MARGIN)
  })

  it('sits just above a bar that spans the middle', () => {
    const obstacles: Box[] = [{ left: 79, right: 400, top: 750, bottom: 903 }]
    expect(clearBottomOffset(915, label(412), obstacles, MARGIN, GAP)).toBe(915 - 750 + GAP)
  })

  it('climbs a stack: over the bar, then over the buttons above it', () => {
    // A phone: the playback bar, and the Tools buttons resting on it,
    // reaching into the middle column.
    const obstacles: Box[] = [
      { left: 79, right: 400, top: 750, bottom: 903 },
      { left: 221, right: 400, top: 708, bottom: 746 },
    ]
    expect(clearBottomOffset(915, label(412), obstacles, MARGIN, GAP)).toBe(915 - 708 + GAP)
  })

  it('ignores what is off to the side, however tall', () => {
    const obstacles: Box[] = [{ left: 0, right: 140, top: 100, bottom: 915 }]
    expect(clearBottomOffset(915, label(412), obstacles, MARGIN, GAP)).toBe(MARGIN)
  })

  it('counts a neighbour closer than the gap as in the way', () => {
    // Ends 3 px short of the label's left edge: closer than the 6 px gap.
    const near: Box[] = [{ left: 0, right: 150, top: 860, bottom: 903 }]
    expect(clearBottomOffset(915, label(412), near, MARGIN, GAP)).toBe(915 - 860 + GAP)
  })

  it('does not climb over something far above the label', () => {
    const high: Box[] = [{ left: 100, right: 300, top: 200, bottom: 400 }]
    expect(clearBottomOffset(915, label(412), high, MARGIN, GAP)).toBe(MARGIN)
  })
})
