// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  coverageOfPixels,
  defaultLayers,
  fetchLayerCatalog,
  resetLayerCatalog,
  type CatalogLayer,
} from './mapLayers'

/** The live catalog's layers (release catalog-2026.08.16-5). */
const LIVE: CatalogLayer[] = [
  { id: 'builtin-nasa-blue-marble', title: 'NASA Blue Marble', kind: 'basemap', url: '/api/layers/file/1' },
  { id: 'builtin-nasa-coastlines', title: 'Global Coastlines', kind: 'overlay', url: '/api/layers/file/2' },
  { id: 'builtin-nasa-earth-at-night', title: 'NASA Earth at Night 2012', kind: 'basemap', url: '/api/layers/file/3' },
  { id: 'builtin-nasa-reference-features', title: 'Borders and Reference Features', kind: 'overlay', url: '/api/layers/file/4' },
  { id: 'builtin-nasa-reference-labels', title: 'Country and City Labels', kind: 'overlay', url: '/api/layers/file/5' },
  { id: 'builtin-nasa-relief-bathymetry', title: 'NASA Relief and Bathymetry', kind: 'basemap', url: '/api/layers/file/6' },
  { id: 'builtin-noaa-etopo1-relief', title: 'NOAA ETOPO1 Shaded Relief', kind: 'basemap', url: '/api/layers/file/7' },
  { id: 'builtin-noaa-graticule', title: 'Latitude and Longitude Grid', kind: 'overlay', url: '/api/layers/file/8' },
]

describe('defaultLayers', () => {
  it('puts relief and bathymetry under a sparse transparent stream, and nothing on top', () => {
    expect(defaultLayers(LIVE, { transparent: true, coverage: 0.08 })).toEqual({
      basemapId: 'builtin-nasa-relief-bathymetry',
      overlays: [],
    })
  })

  it('adds white borders when a transparent stream still hides most of the Earth (Van Gogh wind)', () => {
    expect(defaultLayers(LIVE, { transparent: true, coverage: 0.93 })).toEqual({
      basemapId: 'builtin-nasa-relief-bathymetry',
      overlays: [{ id: 'builtin-nasa-reference-features', tint: 'white' }],
    })
  })

  it('gives an opaque picture borders and no basemap it would hide anyway', () => {
    expect(defaultLayers(LIVE, { transparent: false, coverage: null })).toEqual({
      basemapId: null,
      overlays: [{ id: 'builtin-nasa-reference-features', tint: 'white' }],
    })
  })

  it('prefers published white country borders once the catalog has them, as published', () => {
    const withBorders = [
      ...LIVE,
      { id: 'builtin-noaa-country-borders-black', title: 'Country Borders (black)', kind: 'overlay' as const, url: '/x' },
      { id: 'builtin-noaa-country-borders-white', title: 'Country Borders (white)', kind: 'overlay' as const, url: '/y' },
    ]
    expect(defaultLayers(withBorders, { transparent: false, coverage: null }).overlays)
      .toEqual([{ id: 'builtin-noaa-country-borders-white', tint: 'source' }])
  })

  it('adds no borders while a transparent stream\'s coverage is unmeasured', () => {
    expect(defaultLayers(LIVE, { transparent: true, coverage: null }).overlays).toEqual([])
  })

  it('offers nothing when the catalog has no layers', () => {
    expect(defaultLayers([], { transparent: true, coverage: 1 })).toEqual({ basemapId: null, overlays: [] })
  })
})

describe('coverageOfPixels', () => {
  const px = (...a: number[][]) => new Uint8ClampedArray(a.flat())

  it('counts opaque pixels of an alpha stream', () => {
    expect(coverageOfPixels(px([0, 0, 0, 0], [9, 9, 9, 255], [9, 9, 9, 200], [9, 9, 9, 40]), null)).toBe(0.5)
  })

  it('counts what the palette draws for a value-encoded frame, not every code with a value', () => {
    // A palette that is clear below code 40 (AOD below 0.1, say) and opaque above.
    const lut = new Uint8Array(256 * 4)
    for (let c = 40; c < 256; c++) lut[c * 4 + 3] = 255
    expect(coverageOfPixels(px([0, 0, 0, 255], [30, 30, 30, 255], [45, 45, 45, 255], [200, 200, 200, 255]), lut)).toBe(0.5)
  })
})

describe('fetchLayerCatalog', () => {
  beforeEach(() => resetLayerCatalog())

  it('fetches once per session and keeps only well-formed layers', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      layers: [LIVE[0], { id: 'x', kind: 'weird', url: '/z' }, { title: 'no id' }],
    }), { status: 200 }))
    expect(await fetchLayerCatalog(fetchImpl as unknown as typeof fetch)).toEqual([LIVE[0]])
    await fetchLayerCatalog(fetchImpl as unknown as typeof fetch)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('is empty, not an error, when the endpoint is missing', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 503 }))
    expect(await fetchLayerCatalog(fetchImpl as unknown as typeof fetch)).toEqual([])
  })
})
