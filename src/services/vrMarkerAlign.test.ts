// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import { createVrMarkerAlign, isMarkerAlignRequested } from './vrMarkerAlign'

describe('isMarkerAlignRequested', () => {
  it('is opt-in by ?marker=1', () => {
    expect(isMarkerAlignRequested('?marker=1')).toBe(true)
    expect(isMarkerAlignRequested('?vrDebug=1&marker=1')).toBe(true)
    expect(isMarkerAlignRequested('?marker=0')).toBe(false)
    expect(isMarkerAlignRequested('')).toBe(false)
  })
})

describe('createVrMarkerAlign', () => {
  it('is absent on a session that was not granted the camera picture', () => {
    const session = { enabledFeatures: ['hit-test', 'anchors'] } as unknown as XRSession
    expect(createVrMarkerAlign(session, {} as WebGL2RenderingContext)).toBeNull()
    const bare = {} as unknown as XRSession
    expect(createVrMarkerAlign(bare, {} as WebGL2RenderingContext)).toBeNull()
  })
})
