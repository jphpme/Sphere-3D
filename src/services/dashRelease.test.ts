// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect, vi } from 'vitest'
import {
  buildReleaseLut,
  paletteT,
  parseReleaseEncoding,
  releaseBoundingBox,
  releaseColorScale,
  releaseUvRegion,
  resolveDashRelease,
  valueAtCode,
  vrOverlayOptionsFor,
  type ReleaseEncoding,
} from './dashRelease'
import { buildColorScaleLut } from '../types/color-scale'
import { overlayOptionsFromDataset } from './datasetOverlayOptions'
import type { Dataset } from '../types'

const GEO = { latTop: 90, latBottom: -90, lonLeft: -180, lonRight: 180, pixelCenter: true }
const CODES = { nodataCode: 0, nodataThresholdCode: 20, dataMinCode: 32, dataMaxCode: 235 }
const PALETTE = {
  stops: [
    { t: 0, rgba: [0, 0, 4, 255] },
    { t: 0.5, rgba: [180, 50, 90, 255] },
    { t: 1, rgba: [252, 253, 191, 255] },
  ],
}

/** The shape of the live aod550 release (2026-09-25), palette cut to three stops. */
function release(overrides: { encoding?: Record<string, unknown>; presentation?: Record<string, unknown>; representation?: Record<string, unknown> } = {}) {
  return {
    schema: 'realtime-new.immutable-dash-release.v1',
    representation: { width: 900, height: 466, ...overrides.representation },
    valueEncoding: {
      kind: 'luma8-linear',
      units: 'AOD',
      vmin: 0,
      vmax: 5,
      ...CODES,
      dataRegion: { x: 0, y: 0, width: 900, height: 450 },
      geo: GEO,
      presentation: {
        defaultPalette: PALETTE,
        alphaMode: 'gradient',
        transparentBelowValue: 0.1,
        alphaGradient: { rampStartValue: 0.1, rampEndValue: 2, gamma: 0.6 },
        ...overrides.presentation,
      },
      ...overrides.encoding,
    },
    mpd: { url: 'stream.mpd' },
    dsa: { url: 'dataset.dsa' },
  }
}

function encoding(overrides: Parameters<typeof release>[0] = {}): ReleaseEncoding {
  const enc = parseReleaseEncoding(release(overrides))
  if (!enc) throw new Error('fixture did not parse')
  return enc
}

const alphaAt = (lut: Uint8Array, code: number) => lut[code * 4 + 3]
const rgbaAt = (lut: Uint8Array, code: number) => Array.from(lut.slice(code * 4, code * 4 + 4))

describe('parseReleaseEncoding', () => {
  it('reads the codes, region and presentation the publisher wrote', () => {
    expect(encoding()).toMatchObject({
      kind: 'luma8-linear',
      units: 'AOD',
      vmin: 0,
      vmax: 5,
      nodataThresholdCode: 20,
      dataMinCode: 32,
      dataMaxCode: 235,
      dataRegion: { x: 0, y: 0, width: 900, height: 450 },
      frameWidth: 900,
      frameHeight: 466,
      alphaMode: 'gradient',
      transparentBelowValue: 0.1,
      alphaGradient: { rampStartValue: 0.1, rampEndValue: 2, gamma: 0.6 },
    })
  })

  it('refuses what it cannot decode, so the stream plays as a picture instead', () => {
    expect(parseReleaseEncoding(release({ encoding: { kind: 'luma16-float' } }))).toBeNull()
    expect(parseReleaseEncoding(release({ encoding: { dataRegion: { x: 0, y: 0, width: 900, height: 500 } } }))).toBeNull()
    expect(parseReleaseEncoding(release({ encoding: { dataMinCode: 240 } }))).toBeNull()
    expect(parseReleaseEncoding(release({ presentation: { defaultPalette: { stops: [PALETTE.stops[0]] } } }))).toBeNull()
    expect(parseReleaseEncoding(release({ encoding: { kind: 'luma8-log', vmin: 0 } }))).toBeNull()
    expect(parseReleaseEncoding({ schema: 'x' })).toBeNull()
  })
})

describe('valueAtCode', () => {
  it('maps the data codes linearly, and below the threshold to no data', () => {
    const enc = encoding()
    expect(valueAtCode(enc, 0)).toBeNull()
    expect(valueAtCode(enc, 19)).toBeNull()
    // Between the threshold and dataMinCode: clamped to the bottom.
    expect(valueAtCode(enc, 25)).toBe(0)
    expect(valueAtCode(enc, 32)).toBe(0)
    expect(valueAtCode(enc, 235)).toBe(5)
    expect(valueAtCode(enc, 250)).toBe(5)
    expect(valueAtCode(enc, 133.5)).toBeCloseTo(2.5, 6)
  })

  it('maps a log stream geometrically (Lightning: 1..3000 flashes/hr)', () => {
    const enc = encoding({ encoding: { kind: 'luma8-log', vmin: 1, vmax: 3000 } })
    expect(valueAtCode(enc, 32)).toBeCloseTo(1, 9)
    expect(valueAtCode(enc, 235)).toBeCloseTo(3000, 6)
    expect(valueAtCode(enc, 133.5)).toBeCloseTo(Math.sqrt(3000), 6)
  })

  it('snaps a classified stream to its nearest class (Marine Heatwaves)', () => {
    const enc = encoding({
      encoding: {
        kind: 'luma8-classified',
        vmin: 0,
        vmax: 4,
        classes: [
          { code: 32, value: 0, label: 'None' },
          { code: 83, value: 1, label: 'Moderate' },
          { code: 134, value: 2, label: 'Strong' },
          { code: 184, value: 3, label: 'Severe' },
          { code: 235, value: 4, label: 'Extreme' },
        ],
      },
    })
    expect(valueAtCode(enc, 83)).toBe(1)
    expect(valueAtCode(enc, 85)).toBe(1) // a codec step away
    expect(valueAtCode(enc, 131)).toBe(2)
    // And its colour is that class's, not a blend of two.
    expect(paletteT(enc, 85)).toBe(paletteT(enc, 83))
  })
})

describe('buildReleaseLut', () => {
  it('makes no data transparent, so the Earth shows through', () => {
    const lut = buildReleaseLut(encoding({ presentation: { alphaMode: 'opaque' } }))
    for (let code = 0; code < 20; code++) expect(alphaAt(lut, code)).toBe(0)
    expect(alphaAt(lut, 32)).toBe(255)
  })

  it('fades a gradient stream in with its value (AOD: clear below 0.1, full by 2)', () => {
    const lut = buildReleaseLut(encoding())
    // value < 0.1 below code 36.06
    expect(alphaAt(lut, 36)).toBe(0)
    expect(alphaAt(lut, 37)).toBeGreaterThan(0)
    expect(alphaAt(lut, 60)).toBeLessThan(255)
    // value >= 2 from code 113.2
    expect(alphaAt(lut, 114)).toBe(255)
    expect(alphaAt(lut, 235)).toBe(255)
  })

  it('puts the palette\'s ends on the data codes, not on 0 and 255', () => {
    const lut = buildReleaseLut(encoding({ presentation: { alphaMode: 'opaque' } }))
    expect(rgbaAt(lut, 32)).toEqual([0, 0, 4, 255])
    expect(rgbaAt(lut, 235)).toEqual([252, 253, 191, 255])
    expect(rgbaAt(lut, 255)).toEqual([252, 253, 191, 255])
  })

  it('keeps the palette\'s own alpha (a classified "None" stays clear)', () => {
    const lut = buildReleaseLut(encoding({
      encoding: { kind: 'luma8-classified', classes: [{ code: 32, value: 0, label: 'None' }, { code: 235, value: 4, label: 'Extreme' }] },
      presentation: { alphaMode: 'gradient', transparentBelowValue: undefined, alphaGradient: undefined,
        defaultPalette: { stops: [{ t: 0, rgba: [0, 0, 0, 0] }, { t: 1, rgba: [140, 0, 0, 230] }] } },
    }))
    expect(alphaAt(lut, 33)).toBe(0)
    expect(rgbaAt(lut, 234)).toEqual([140, 0, 0, 230])
  })
})

describe('releaseColorScale', () => {
  it('reaches the VR shader as exactly the release\'s palette', () => {
    for (const enc of [
      encoding(),
      encoding({ presentation: { alphaMode: 'binary' } }),
      encoding({ encoding: { kind: 'luma8-log', vmin: 0.1, vmax: 55 } }),
    ]) {
      expect(Array.from(buildColorScaleLut(releaseColorScale(enc)))).toEqual(Array.from(buildReleaseLut(enc)))
    }
  })

  it('keeps a linear code-to-value reading right across the data codes', () => {
    const enc = encoding()
    const scale = releaseColorScale(enc)
    const readAt = (code: number) => scale.vmin + (code / 255) * (scale.vmax - scale.vmin)
    expect(readAt(32)).toBeCloseTo(0, 9)
    expect(readAt(235)).toBeCloseTo(5, 9)
    expect(scale.units).toBe('AOD')
  })
})

describe('releaseUvRegion', () => {
  it('leaves the calibration strip under the map out of the lookup', () => {
    expect(releaseUvRegion(encoding())).toEqual({ u0: 0, v0: 16 / 466, us: 1, vs: 450 / 466 })
  })

  it('handles a frame with an auxiliary block as well (IMERG: 2048x2072, map 2048x1024)', () => {
    const enc = encoding({
      representation: { width: 2048, height: 2072 },
      encoding: { dataRegion: { x: 0, y: 0, width: 2048, height: 1024 } },
    })
    expect(releaseUvRegion(enc)).toEqual({ u0: 0, v0: 1048 / 2072, us: 1, vs: 1024 / 2072 })
  })
})

describe('releaseBoundingBox', () => {
  it('is null for the whole globe and a box for a regional release', () => {
    expect(releaseBoundingBox(encoding())).toBeNull()
    expect(releaseBoundingBox(encoding({ encoding: { geo: { latTop: 54, latBottom: 50, lonLeft: 3, lonRight: 8 } } })))
      .toEqual({ n: 54, s: 50, w: 3, e: 8 })
  })
})

describe('resolveDashRelease', () => {
  const LATEST = 'https://streams.example/global/realtime/x/aod550/latest.json'

  it('follows latest.json to the release and resolves its files beside it', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === LATEST) {
        return new Response(JSON.stringify({ releaseDescriptor: { url: 'releases/r22/release.json' } }), { status: 200 })
      }
      if (url === 'https://streams.example/global/realtime/x/aod550/releases/r22/release.json') {
        return new Response(JSON.stringify(release()), { status: 200 })
      }
      return new Response('', { status: 404 })
    })

    const resolved = await resolveDashRelease(LATEST, fetchImpl as unknown as typeof fetch)

    expect(resolved.mpdUrl).toBe('https://streams.example/global/realtime/x/aod550/releases/r22/stream.mpd')
    expect(resolved.dsaUrl).toBe('https://streams.example/global/realtime/x/aod550/releases/r22/dataset.dsa')
    expect(resolved.encoding?.kind).toBe('luma8-linear')
  })

  it('names the step that failed', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 404 }))
    await expect(resolveDashRelease(LATEST, fetchImpl as unknown as typeof fetch)).rejects.toThrow(/Release pointer .* 404/)
  })
})

describe('vrOverlayOptionsFor', () => {
  const dataset = { id: 'R2_DASH_x', title: 'x', format: 'application/dash+xml', dataLink: 'x.mpd' } as Dataset

  it('leaves every other dataset exactly as the shared options draw it', () => {
    expect(vrOverlayOptionsFor(dataset)).toEqual(overlayOptionsFromDataset(dataset))
  })

  it('adds the release\'s palette and crop for a resolved release', () => {
    const options = vrOverlayOptionsFor({ ...dataset, vrValueEncoding: encoding() })
    expect(options?.dataRegion).toEqual({ u0: 0, v0: 16 / 466, us: 1, vs: 450 / 466 })
    expect(options?.colorScale?.stops).toHaveLength(256)
    expect(options?.boundingBox).toBeUndefined()
  })
})
