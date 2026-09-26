// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * AYNI — the basemaps and overlays stacked around a dataset, on both the
 * browser globe (earthTileLayer's map-layer passes) and the VR/AR globe
 * (photorealEarth's base map + the overlay shells).
 *
 * The layers come from the signed AYNI catalog through `/api/layers`: its
 * `builtin-*` datasets, each a basemap or an overlay by its descriptor's
 * role. Which ones a dataset gets by default follows its coverage:
 *
 *   - Anything with transparency — an alpha stream, a value-encoded
 *     palette — gets a basemap underneath, so its see-through regions
 *     show the Earth rather than black. It costs nothing where the data
 *     is opaque.
 *   - Data that hides most of the Earth gets country borders on top, drawn
 *     white, so a full-cover field (the Van Gogh wind, a temperature map)
 *     still says where it is. "Most" is measured on the first frame
 *     (`measureCoverage`), because an alpha stream's flag says nothing
 *     about how much of the sphere it actually covers.
 *
 * A visitor can change either from the layer picker; that choice holds
 * until the next dataset loads, which starts from its own defaults.
 */

import type { MapLayerTint } from './earthTileLayer'

export type { MapLayerTint }

export interface CatalogLayer {
  readonly id: string
  readonly title: string
  readonly kind: 'basemap' | 'overlay'
  readonly url: string
}

export interface LayerSelection {
  readonly basemapId: string | null
  readonly overlays: ReadonlyArray<{ readonly id: string; readonly tint: MapLayerTint }>
}

export const NO_LAYERS: LayerSelection = { basemapId: null, overlays: [] }

/** What the defaults depend on. */
export interface DatasetLayerFacts {
  /** Frames carry transparency: an alpha stream or a value-encoded palette. */
  readonly transparent: boolean
  /** Fraction (0..1) of the first frame that hides the Earth, or null when unmeasured. */
  readonly coverage: number | null
}

/** Above this measured coverage the data hides the Earth, and borders go on top. */
export const FULL_COVER = 0.7

const PREFERRED_BASEMAP = 'builtin-nasa-relief-bathymetry'

/**
 * The borders overlay to use, best first: a layer published as white
 * country borders, then any country borders, then the NASA reference
 * features (borders among them), then coastlines.
 */
function pickBorders(layers: readonly CatalogLayer[]): CatalogLayer | null {
  const overlays = layers.filter(l => l.kind === 'overlay')
  const text = (l: CatalogLayer) => `${l.id} ${l.title}`.toLowerCase()
  return overlays.find(l => /country[\s_-]*borders?/.test(text(l)) && /white/.test(text(l)))
    ?? overlays.find(l => /country[\s_-]*borders?/.test(text(l)))
    ?? overlays.find(l => l.id === 'builtin-nasa-reference-features')
    ?? overlays.find(l => /coastline/.test(text(l)))
    ?? null
}

/** A layer published in a colour keeps it; line art without one is drawn white. */
function tintFor(layer: CatalogLayer): MapLayerTint {
  return /\b(white|black)\b|_(white|black)\b/i.test(`${layer.id} ${layer.title}`) ? 'source' : 'white'
}

/** The layers a dataset starts with. */
export function defaultLayers(layers: readonly CatalogLayer[], facts: DatasetLayerFacts): LayerSelection {
  const basemaps = layers.filter(l => l.kind === 'basemap')
  const basemap = facts.transparent
    ? basemaps.find(l => l.id === PREFERRED_BASEMAP) ?? basemaps[0] ?? null
    : null
  // An opaque picture hides the Earth by definition; a transparent one
  // only when its frames say so. Unmeasured transparency gets no borders:
  // better a missing aid than lines scribbled over a sparse map.
  const hidesEarth = !facts.transparent || (facts.coverage !== null && facts.coverage >= FULL_COVER)
  const borders = hidesEarth ? pickBorders(layers) : null
  return {
    basemapId: basemap?.id ?? null,
    overlays: borders ? [{ id: borders.id, tint: tintFor(borders) }] : [],
  }
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

const SAMPLE_W = 64
const SAMPLE_H = 32

/**
 * Fraction of a frame that hides the Earth: pixels with alpha above one
 * half for an alpha stream, or — for a value-encoded frame, whose alpha
 * is always opaque — codes the palette draws at least half opaque (a
 * palette can make low values transparent too, so "has a value" is not
 * "covers the Earth"). Sampled on a 64x32
 * copy, which is plenty for "most of the sphere". Null when the frame
 * cannot be read (not decoded yet, or a cross-origin taint).
 */
export function measureCoverage(
  source: CanvasImageSource & { readonly width?: number },
  mode: { kind: 'alpha' } | { kind: 'palette'; lut: Uint8Array; crop?: { x: number; y: number; width: number; height: number } },
): number | null {
  try {
    const canvas = document.createElement('canvas')
    canvas.width = SAMPLE_W
    canvas.height = SAMPLE_H
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    if (mode.kind === 'palette' && mode.crop) {
      const c = mode.crop
      ctx.drawImage(source, c.x, c.y, c.width, c.height, 0, 0, SAMPLE_W, SAMPLE_H)
    } else {
      ctx.drawImage(source, 0, 0, SAMPLE_W, SAMPLE_H)
    }
    const px = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data
    return coverageOfPixels(px, mode.kind === 'palette' ? mode.lut : null)
  } catch {
    return null
  }
}

/** The counting half of {@link measureCoverage}, separate so it can be tested without a canvas. */
export function coverageOfPixels(rgba: Uint8ClampedArray | Uint8Array, lut: Uint8Array | null): number {
  let covered = 0
  const n = rgba.length / 4
  for (let i = 0; i < n; i++) {
    const o = i * 4
    if (lut ? lut[rgba[o]! * 4 + 3]! > 127 : rgba[o + 3]! > 127) covered++
  }
  return n ? covered / n : 0
}

// ---------------------------------------------------------------------------
// Catalog + images
// ---------------------------------------------------------------------------

let catalogPromise: Promise<CatalogLayer[]> | null = null

/** The catalog's layers, fetched once per session; empty when unavailable. */
export function fetchLayerCatalog(fetchImpl: typeof fetch = fetch): Promise<CatalogLayer[]> {
  catalogPromise ??= (async () => {
    try {
      const res = await fetchImpl('/api/layers', { headers: { Accept: 'application/json' } })
      if (!res.ok) return []
      const body = await res.json() as { layers?: CatalogLayer[] }
      return Array.isArray(body.layers)
        ? body.layers.filter(l => l && typeof l.id === 'string' && typeof l.url === 'string' && (l.kind === 'basemap' || l.kind === 'overlay'))
        : []
    } catch {
      return []
    }
  })()
  return catalogPromise
}

/** For tests. */
export function resetLayerCatalog(): void {
  catalogPromise = null
  images.clear()
}

const images = new Map<string, Promise<HTMLImageElement | null>>()

/** A layer image, decoded once and shared by every globe; null if it fails to load. */
export function loadLayerImage(url: string): Promise<HTMLImageElement | null> {
  let pending = images.get(url)
  if (!pending) {
    pending = new Promise(resolve => {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.decoding = 'async'
      img.onload = () => resolve(img)
      img.onerror = () => resolve(null)
      img.src = url
    })
    images.set(url, pending)
  }
  return pending
}

/**
 * The images for a selection, in stack order, for a renderer's
 * `setMapLayers`. Layers that are unknown or fail to load are left out.
 */
export async function resolveLayerImages(
  layers: readonly CatalogLayer[],
  selection: LayerSelection,
): Promise<{ basemap: HTMLImageElement | null; overlays: Array<{ image: HTMLImageElement; tint: MapLayerTint }> }> {
  const byId = new Map(layers.map(l => [l.id, l]))
  const basemapLayer = selection.basemapId ? byId.get(selection.basemapId) : undefined
  const [basemap, ...overlayImages] = await Promise.all([
    basemapLayer ? loadLayerImage(basemapLayer.url) : Promise.resolve(null),
    ...selection.overlays.map(o => {
      const layer = byId.get(o.id)
      return layer ? loadLayerImage(layer.url) : Promise.resolve(null)
    }),
  ])
  const overlays: Array<{ image: HTMLImageElement; tint: MapLayerTint }> = []
  selection.overlays.forEach((o, i) => {
    const image = overlayImages[i]
    if (image) overlays.push({ image, tint: o.tint })
  })
  return { basemap: basemap ?? null, overlays }
}
