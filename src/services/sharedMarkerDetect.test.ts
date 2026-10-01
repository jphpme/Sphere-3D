// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import {
  MARKER_CODE,
  MARKER_CODE_CELLS,
  MARKER_CODE_LENGTH,
  MARKER_GRID,
  MARKER_QUIET,
  buildMarkerSvg,
  markerCellIsDark,
} from './sharedMarker'
import {
  cameraPixelsToGray,
  detectMarker,
  squareToQuad,
  type GrayImage,
  type Point2,
} from './sharedMarkerDetect'

interface RenderOptions {
  width?: number
  height?: number
  /** Gray level of whatever the sheet lies on. */
  table?: number
  /** Brightness falls linearly to this fraction across the picture. */
  shade?: number
  /** Peak-to-peak sensor noise, in gray levels. */
  noise?: number
  /** Swap left and right, as a mirror would. */
  mirror?: boolean
}

/** Deterministic noise, so a failure reproduces. */
function lcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0xffffffff
  }
}

/**
 * Draw the marker with its frame's corners at `corners` (top-left,
 * top-right, bottom-right, bottom-left), on a white sheet, on a table.
 * The centre carries a mid-gray disc standing in for the mark.
 */
function renderMarker(corners: Point2[], opts: RenderOptions = {}): GrayImage {
  const width = opts.width ?? 640
  const height = opts.height ?? 480
  const table = opts.table ?? 95
  const random = lcg(7)
  // Invert the square → quad mapping numerically: Newton from the centre.
  const forward = squareToQuad(corners)
  const inverse = (x: number, y: number): Point2 => {
    let u = 0.5
    let v = 0.5
    for (let i = 0; i < 12; i++) {
      const p = forward(u, v)
      const e = 1e-4
      const pu = forward(u + e, v)
      const pv = forward(u, v + e)
      const a = (pu.x - p.x) / e
      const b = (pv.x - p.x) / e
      const c = (pu.y - p.y) / e
      const d = (pv.y - p.y) / e
      const det = a * d - b * c
      const rx = x - p.x
      const ry = y - p.y
      u += (d * rx - b * ry) / det
      v += (a * ry - c * rx) / det
    }
    return { x: u, y: v }
  }
  const quiet = MARKER_QUIET / MARKER_GRID
  const data = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = opts.mirror ? width - 1 - x : x
      const { x: u, y: v } = inverse(sx + 0.5, y + 0.5)
      let level = table
      if (u >= -quiet && v >= -quiet && u <= 1 + quiet && v <= 1 + quiet) {
        level = 235
        if (u >= 0 && v >= 0 && u < 1 && v < 1) {
          const dark = markerCellIsDark(Math.floor(v * MARKER_GRID), Math.floor(u * MARKER_GRID))
          if (dark === true) level = 25
          else if (dark === null && Math.hypot(u - 0.5, v - 0.5) < 0.2) level = 140
        }
      }
      const shade = opts.shade === undefined ? 1 : 1 - (1 - opts.shade) * (x / width)
      const noise = opts.noise ? (random() - 0.5) * opts.noise : 0
      data[y * width + x] = Math.max(0, Math.min(255, level * shade + noise))
    }
  }
  return { data, width, height }
}

/** A square of `size` px centred at (cx, cy), turned by `degrees`. */
function square(cx: number, cy: number, size: number, degrees = 0): Point2[] {
  const r = (degrees * Math.PI) / 180
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([x, y]) => ({
    x: cx + (size / 2) * (x * Math.cos(r) - y * Math.sin(r)),
    y: cy + (size / 2) * (x * Math.sin(r) + y * Math.cos(r)),
  }))
}

function expectCorners(found: Point2[], expected: Point2[], tolerance = 1.6): void {
  for (let i = 0; i < 4; i++) {
    expect(Math.hypot(found[i].x - expected[i].x, found[i].y - expected[i].y)).toBeLessThan(tolerance)
  }
}

describe('the marker layout', () => {
  it('reads 20 code squares around a 4 x 4 centre', () => {
    expect(MARKER_CODE).toHaveLength(MARKER_CODE_LENGTH)
    expect(MARKER_CODE_CELLS).toHaveLength(MARKER_CODE_LENGTH)
    expect(new Set(MARKER_CODE_CELLS.map(([r, c]) => `${r},${c}`)).size).toBe(MARKER_CODE_LENGTH)
    expect(markerCellIsDark(0, 3)).toBe(true)
    expect(markerCellIsDark(3, 4)).toBeNull()
  })

  it('keeps its four rotations far apart', () => {
    const side = MARKER_CODE_LENGTH / 4
    for (let turn = 1; turn < 4; turn++) {
      let differ = 0
      for (let i = 0; i < MARKER_CODE_LENGTH; i++) {
        if (MARKER_CODE[i] !== MARKER_CODE[(i + side * turn) % MARKER_CODE_LENGTH]) differ++
      }
      expect(differ).toBeGreaterThanOrEqual(12)
    }
  })

  it('draws every black module and nests the mark in the centre', () => {
    const svg = buildMarkerSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><title>AYNI XR</title><circle r="5"/></svg>')
    const black = 28 + MARKER_CODE.filter(Boolean).length
    // One for the white sheet, then one per black module.
    expect(svg.match(/<rect /g)).toHaveLength(1 + black)
    expect(svg).toContain('viewBox="0 0 10 10"')
    expect(svg).toContain('<svg x="3.3" y="3.3" width="3.4" height="3.4"')
    expect(svg.match(/<title>/g)).toHaveLength(1)
  })
})

describe('detectMarker', () => {
  it('finds an upright marker and orders its corners as printed', () => {
    const corners = square(320, 240, 200)
    const found = detectMarker(renderMarker(corners))
    expect(found).not.toBeNull()
    expect(found!.codeErrors).toBe(0)
    expectCorners(found!.corners, corners)
  })

  it.each([37, 90, 135, 180, 262, 315])('finds it turned by %i degrees', (degrees) => {
    const corners = square(300, 250, 170, degrees)
    const found = detectMarker(renderMarker(corners))
    expect(found).not.toBeNull()
    expectCorners(found!.corners, corners)
  })

  it('finds it seen at a slant, as on a table', () => {
    // A trapezoid: the far edge shorter than the near one, and off-centre.
    const corners = [
      { x: 250, y: 150 },
      { x: 420, y: 160 },
      { x: 470, y: 330 },
      { x: 180, y: 310 },
    ]
    const found = detectMarker(renderMarker(corners))
    expect(found).not.toBeNull()
    expectCorners(found!.corners, corners)
  })

  it('finds a small marker, about four pixels to a module', () => {
    const corners = square(200, 300, 34, 20)
    const found = detectMarker(renderMarker(corners))
    expect(found).not.toBeNull()
    expectCorners(found!.corners, corners, 2)
  })

  it('finds it under a shadow, with sensor noise, on a dark table', () => {
    const corners = square(330, 230, 180, 12)
    const found = detectMarker(renderMarker(corners, { shade: 0.45, noise: 24, table: 40 }))
    expect(found).not.toBeNull()
    expectCorners(found!.corners, corners, 2.5)
  })

  it('finds it on a table brighter than the ink but darker than the sheet', () => {
    const corners = square(320, 240, 150, 200)
    const found = detectMarker(renderMarker(corners, { table: 170 }))
    expect(found).not.toBeNull()
    expectCorners(found!.corners, corners)
  })

  it('refuses a mirror image', () => {
    expect(detectMarker(renderMarker(square(320, 240, 200), { mirror: true }))).toBeNull()
  })

  it('refuses a marker cut by the edge of the picture', () => {
    expect(detectMarker(renderMarker(square(40, 240, 200)))).toBeNull()
  })

  it('finds nothing in an empty picture or a plain dark square', () => {
    const blank = { data: new Uint8Array(320 * 240).fill(128), width: 320, height: 240 }
    expect(detectMarker(blank)).toBeNull()
    const solid = new Uint8Array(320 * 240).fill(220)
    for (let y = 60; y < 180; y++) for (let x = 100; x < 220; x++) solid[y * 320 + x] = 20
    expect(detectMarker({ data: solid, width: 320, height: 240 })).toBeNull()
  })
})

/** A w x h RGBA readback whose pixel (x, y) is gray level `x + 10 * y`. */
function readback(width: number, height: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const level = x + 10 * y
      rgba.set([level, level, level, 255], (y * width + x) * 4)
    }
  }
  return rgba
}

describe('cameraPixelsToGray', () => {
  it('keeps the rows as read when the first row is the top', () => {
    const gray = cameraPixelsToGray(readback(4, 3), 4, 3, false)
    expect(gray.width).toBe(4)
    expect(gray.height).toBe(3)
    expect(Array.from(gray.data.slice(0, 4))).toEqual([0, 1, 2, 3])
    expect(gray.data[2 * 4 + 1]).toBe(21)
  })

  it('turns a bottom-first readback the right way up', () => {
    const gray = cameraPixelsToGray(readback(4, 3), 4, 3, true)
    expect(Array.from(gray.data.slice(0, 4))).toEqual([20, 21, 22, 23])
    expect(gray.data[2 * 4]).toBe(0)
  })

  it('reduces a large frame by whole steps', () => {
    const gray = cameraPixelsToGray(readback(16, 8), 16, 8, false, 4)
    expect(gray.width).toBe(4)
    expect(gray.height).toBe(2)
    // Every fourth pixel of every fourth row.
    expect(Array.from(gray.data)).toEqual([0, 4, 8, 12, 40, 44, 48, 52])
  })

  it('weighs the channels as luminance', () => {
    const green = new Uint8Array([0, 255, 0, 255])
    const blue = new Uint8Array([0, 0, 255, 255])
    expect(cameraPixelsToGray(green, 1, 1, false).data[0]).toBeGreaterThan(
      cameraPixelsToGray(blue, 1, 1, false).data[0] * 4,
    )
  })
})
