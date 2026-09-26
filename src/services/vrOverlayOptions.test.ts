// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect } from 'vitest'
import { vrOverlayOptionsFor } from './vrOverlayOptions'
import { overlayOptionsFromDataset } from './datasetOverlayOptions'
import { parseReleaseEncoding, type ReleaseEncoding } from './dashRelease'
import type { Dataset } from '../types'

const GEO = { latTop: 90, latBottom: -90, lonLeft: -180, lonRight: 180 }
function encoding(): ReleaseEncoding {
  const enc = parseReleaseEncoding({
    representation: { width: 900, height: 466 },
    valueEncoding: {
      kind: 'luma8-linear', units: 'AOD', vmin: 0, vmax: 5,
      nodataCode: 0, nodataThresholdCode: 20, dataMinCode: 32, dataMaxCode: 235,
      dataRegion: { x: 0, y: 0, width: 900, height: 450 }, geo: GEO,
      presentation: { alphaMode: 'opaque', defaultPalette: { stops: [{ t: 0, rgba: [0, 0, 4, 255] }, { t: 1, rgba: [252, 253, 191, 255] }] } },
    },
  })
  if (!enc) throw new Error('fixture')
  return enc
}

describe('vrOverlayOptionsFor', () => {
  const dataset = { id: 'R2_DASH_x', title: 'x', format: 'application/dash+xml', dataLink: 'x.mpd' } as Dataset

  it('leaves every other dataset exactly as the shared options draw it', () => {
    expect(vrOverlayOptionsFor(dataset)).toEqual(overlayOptionsFromDataset(dataset))
  })

  it('adds the release\'s palette, image-space crop and flipped VR region for a resolved release', () => {
    const options = vrOverlayOptionsFor({ ...dataset, releaseEncoding: encoding() })
    // THREE samples with v == 1 at the top row …
    expect(options?.dataRegion).toEqual({ u0: 0, v0: 16 / 466, us: 1, vs: 450 / 466 })
    // … the browser globe and the value readout with v == 0 there.
    expect(options?.cropRect).toEqual({ u0: 0, v0: 0, us: 1, vs: 450 / 466 })
    expect(options?.colorScale?.stops).toHaveLength(256)
    expect(options?.releaseEncoding?.kind).toBe('luma8-linear')
    expect(options?.boundingBox).toBeUndefined()
  })
})

describe('the shared bundle for a release (both globes)', () => {
  const dataset = { id: 'R2_DASH_x', title: 'x', format: 'application/dash+xml', dataLink: 'x.mpd' } as Dataset

  it('reaches the browser globe with the palette, crop and decoding rules too', () => {
    const shared = overlayOptionsFromDataset({ ...dataset, releaseEncoding: encoding() })
    expect(shared?.cropRect).toEqual({ u0: 0, v0: 0, us: 1, vs: 450 / 466 })
    expect(shared?.colorScale?.transparentRange).toBeCloseTo(20 / 255, 9)
    expect(shared?.releaseEncoding?.dataMaxCode).toBe(235)
  })
})
