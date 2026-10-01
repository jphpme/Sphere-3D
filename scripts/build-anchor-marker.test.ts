// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { OUTPUT, renderAnchorMarker } from './build-anchor-marker'

describe('public/ayni-xr-anchor.svg', () => {
  it('is what the marker layout renders to', () => {
    // Stale? `npm run build:anchor-marker` rewrites it.
    expect(readFileSync(OUTPUT, 'utf8')).toBe(renderAnchorMarker())
  })
})
