// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bordersChoice,
  coverageOfPixels,
  defaultLayers,
  withBordersChoice,
  fetchLayerCatalog,
  resetLayerCatalog,
  streamHostLayers,
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
    expect(defaultLayers(LIVE, { streamed: true, transparent: true, coverage: 0.08 })).toEqual({
      basemapId: 'builtin-nasa-relief-bathymetry',
      overlays: [],
    })
  })

  it('adds white borders only when a transparent stream has no see-through texel (0.1 % tolerated)', () => {
    // The owner's rule, shared with the desktop apps: a field that leaves
    // any of the Earth showing (the Van Gogh wind at 93 %) gets no borders.
    expect(defaultLayers(LIVE, { streamed: true, transparent: true, coverage: 0.93 })).toEqual({
      basemapId: 'builtin-nasa-relief-bathymetry',
      overlays: [],
    })
    expect(defaultLayers(LIVE, { streamed: true, transparent: true, coverage: 0.9995 })).toEqual({
      basemapId: 'builtin-nasa-relief-bathymetry',
      overlays: [{ id: 'builtin-nasa-reference-features', tint: 'white' }],
    })
  })

  it('gives an opaque picture borders and no basemap it would hide anyway', () => {
    expect(defaultLayers(LIVE, { streamed: true, transparent: false, coverage: null })).toEqual({
      basemapId: null,
      overlays: [{ id: 'builtin-nasa-reference-features', tint: 'white' }],
    })
  })

  it('prefers "Country Borders (black)", the one the rule names, drawn as published', () => {
    const withBorders = [
      ...LIVE,
      { id: 'builtin-noaa-country-borders-white', title: 'Country Borders (white)', kind: 'overlay' as const, url: '/y' },
      ...streamHostLayers('https://streams.example/'),
    ]
    expect(defaultLayers(withBorders, { streamed: true, transparent: false, coverage: null }).overlays)
      .toEqual([{ id: 'stream-country-borders-black', tint: 'source' }])
  })

  it('never adds borders to a catalog picture or a plain video, opaque or not', () => {
    expect(defaultLayers(LIVE, { streamed: false, transparent: false, coverage: null }).overlays).toEqual([])
    expect(defaultLayers(LIVE, { streamed: false, transparent: true, coverage: 1 }).overlays).toEqual([])
  })

  it('adds no borders while a transparent stream\'s coverage is unmeasured', () => {
    expect(defaultLayers(LIVE, { streamed: true, transparent: true, coverage: null }).overlays).toEqual([])
  })

  it('offers nothing when the catalog has no layers', () => {
    expect(defaultLayers([], { streamed: true, transparent: true, coverage: 1 })).toEqual({ basemapId: null, overlays: [] })
  })
})

describe('the viewer\'s word on borders', () => {
  const borders = { id: 'builtin-nasa-reference-features', tint: 'white' as const }
  const grid = { id: 'builtin-noaa-graticule', tint: 'white' as const }
  const withBorders = { basemapId: null, overlays: [borders] }
  const without = { basemapId: null, overlays: [grid] }

  it('reads a switch of the borders overlay, and nothing from other changes', () => {
    expect(bordersChoice(without, { basemapId: null, overlays: [grid, borders] }, LIVE)).toBe('on')
    expect(bordersChoice(withBorders, without, LIVE)).toBe('off')
    expect(bordersChoice(without, { basemapId: 'builtin-nasa-blue-marble', overlays: [] }, LIVE)).toBeNull()
    expect(bordersChoice(without, withBorders, [])).toBeNull()
  })

  it('keeps borders the viewer asked for on a dataset that would not get them', () => {
    const sparse = defaultLayers(LIVE, { streamed: true, transparent: true, coverage: 0.08 })
    expect(withBordersChoice(sparse, 'on', LIVE)).toEqual({
      basemapId: 'builtin-nasa-relief-bathymetry',
      overlays: [borders],
    })
  })

  it('keeps borders off where the viewer turned them off, and changes nothing without a word', () => {
    const opaque = defaultLayers(LIVE, { streamed: true, transparent: false, coverage: null })
    expect(withBordersChoice(opaque, 'off', LIVE).overlays).toEqual([])
    expect(withBordersChoice(opaque, null, LIVE)).toBe(opaque)
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

  it('lists the stream host\'s borders after the catalog, and alone when the catalog is down', async () => {
    vi.stubEnv('VITE_REALTIME_DASH_BASE_URL', 'https://streams.example')
    try {
      const ok = vi.fn(async () => new Response(JSON.stringify({ layers: [LIVE[0]] }), { status: 200 }))
      expect(await fetchLayerCatalog(ok as unknown as typeof fetch)).toEqual([LIVE[0], {
        id: 'stream-country-borders-black',
        title: 'Country Borders (black)',
        kind: 'overlay',
        url: 'https://streams.example/global/projection/shared/country_borders_black_v1.png',
      }])
      resetLayerCatalog()
      const down = vi.fn(async () => { throw new TypeError('offline') })
      expect((await fetchLayerCatalog(down as unknown as typeof fetch)).map(l => l.id)).toEqual(['stream-country-borders-black'])
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('streamHostLayers', () => {
  it('names nothing without a stream host', () => {
    expect(streamHostLayers(undefined)).toEqual([])
    expect(streamHostLayers('  ')).toEqual([])
  })
})
