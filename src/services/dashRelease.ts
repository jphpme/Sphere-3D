// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * AYNI — value-encoded DASH releases, on the browser globe and the immersive one.
 *
 * The stream host publishes some streams as immutable releases rather
 * than a fixed MPD: the index row names a `latest.json` pointer, which
 * names a `release.json`, which names the MPD, the `.dsa`, and how the
 * frames encode their values (`valueEncoding`). Those frames are not
 * pictures: luma carries a measurement (`luma8-linear`, `luma8-log` or
 * `luma8-classified`), the bottom rows of every frame are a calibration
 * strip rather than map, and the colours come from a palette the
 * release declares.
 *
 * This module resolves a release and turns its encoding into what both
 * globes already know how to draw — a 256-entry palette indexed by the
 * raw luma code (the data-encoded branches of earthTileLayer and
 * photorealEarth) — plus the rectangle of the frame the map occupies,
 * and the exact decoder the value readout uses. overlayOptionsFromDataset
 * carries it all. `Dataset.renderEncoding` is left unset, so the analysis
 * tools (which read the whole frame and decode linearly) and the
 * generated colorbar stay off for these streams.
 *
 * The code layout is the publisher's, read from the file rather than
 * assumed: codes below `nodataThresholdCode` are no data (transparent,
 * so the real Earth shows through); `dataMinCode`..`dataMaxCode` span
 * the palette, with the codes between the threshold and `dataMinCode`
 * clamped to its bottom; and the value behind a code is linear or
 * logarithmic between `vmin` and `vmax`, or a class for a classified
 * stream. Transparency follows `presentation.alphaMode`.
 */

import type { ColorScale, ColorScaleStop } from '../types/color-scale'
import type { ReleaseClass, ReleaseEncoding, ReleaseEncodingKind } from '../types/release-encoding'
import { COLOR_SCALE_LUT_SIZE } from '../types/color-scale'

export type { ReleaseClass, ReleaseEncoding, ReleaseEncodingKind } from '../types/release-encoding'

/** What a resolved release gives the loader. */
export interface ResolvedRelease {
  readonly mpdUrl: string
  readonly dsaUrl: string | null
  readonly encoding: ReleaseEncoding | null
}

/**
 * The texture rectangle holding the map, as offset + scale in THREE's
 * UV space (v == 1 is the image's top row). `{ u0: 0, v0: 0, us: 1, vs: 1 }`
 * is the whole frame.
 */
export interface VrUvRegion {
  readonly u0: number
  readonly v0: number
  readonly us: number
  readonly vs: number
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function rec(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function parseStops(raw: unknown): ColorScaleStop[] {
  if (!Array.isArray(raw)) return []
  const stops: ColorScaleStop[] = []
  for (const s of raw) {
    const r = rec(s)
    const t = num(r?.t)
    const rgba = r?.rgba
    if (t === null || t < 0 || t > 1 || !Array.isArray(rgba) || rgba.length !== 4) return []
    const c = rgba.map(num)
    if (c.some(v => v === null || v < 0 || v > 255)) return []
    stops.push({ t, rgba: [c[0]!, c[1]!, c[2]!, c[3]!] })
  }
  return stops.sort((a, b) => a.t - b.t)
}

const KINDS = new Set<ReleaseEncodingKind>(['luma8-linear', 'luma8-log', 'luma8-classified'])

/**
 * `valueEncoding` from a `release.json`, or null when the release is
 * not one this globe can decode — an unknown kind, a palette of fewer
 * than two stops, a degenerate code range, or a region outside the
 * frame. Null means "play it as a picture", never a guess.
 */
export function parseReleaseEncoding(release: unknown): ReleaseEncoding | null {
  const r = rec(release)
  const e = rec(r?.valueEncoding)
  const rep = rec(r?.representation)
  if (!e || !rep) return null
  const kind = e.kind
  if (typeof kind !== 'string' || !KINDS.has(kind as ReleaseEncodingKind)) return null

  const vmin = num(e.vmin)
  const vmax = num(e.vmax)
  const threshold = num(e.nodataThresholdCode)
  const lo = num(e.dataMinCode)
  const hi = num(e.dataMaxCode)
  const frameWidth = num(rep.width)
  const frameHeight = num(rep.height)
  const region = rec(e.dataRegion)
  const geo = rec(e.geo)
  const pres = rec(e.presentation)
  if (vmin === null || vmax === null || vmin === vmax) return null
  if (threshold === null || lo === null || hi === null || !(threshold <= lo && lo < hi && hi <= 255)) return null
  if (!frameWidth || !frameHeight || !region || !geo) return null
  if (kind === 'luma8-log' && !(vmin > 0 && vmax > 0)) return null

  const dataRegion = {
    x: num(region.x) ?? 0,
    y: num(region.y) ?? 0,
    width: num(region.width) ?? frameWidth,
    height: num(region.height) ?? frameHeight,
  }
  if (dataRegion.x < 0 || dataRegion.y < 0 || dataRegion.width <= 0 || dataRegion.height <= 0 ||
      dataRegion.x + dataRegion.width > frameWidth || dataRegion.y + dataRegion.height > frameHeight) {
    return null
  }
  const latTop = num(geo.latTop)
  const latBottom = num(geo.latBottom)
  const lonLeft = num(geo.lonLeft)
  const lonRight = num(geo.lonRight)
  if (latTop === null || latBottom === null || lonLeft === null || lonRight === null) return null

  const stops = parseStops(rec(pres?.defaultPalette)?.stops)
  if (stops.length < 2) return null

  const mode = pres?.alphaMode
  const alphaMode = mode === 'gradient' || mode === 'binary' || mode === 'opaque' ? mode : 'binary'
  const grad = rec(pres?.alphaGradient)
  const rampStart = num(grad?.rampStartValue)
  const rampEnd = num(grad?.rampEndValue)
  const classes: ReleaseClass[] = Array.isArray(e.classes)
    ? e.classes
        .map(rec)
        .filter((c): c is Record<string, unknown> => c !== null && num(c.code) !== null && num(c.value) !== null)
        .map(c => ({ code: num(c.code)!, value: num(c.value)!, label: typeof c.label === 'string' ? c.label : '' }))
        .sort((a, b) => a.code - b.code)
    : []

  return {
    kind: kind as ReleaseEncodingKind,
    units: typeof e.units === 'string' && e.units.trim() ? e.units : null,
    vmin,
    vmax,
    nodataThresholdCode: threshold,
    dataMinCode: lo,
    dataMaxCode: hi,
    dataRegion,
    frameWidth,
    frameHeight,
    geo: { latTop, latBottom, lonLeft, lonRight },
    stops,
    alphaMode,
    transparentBelowValue: num(pres?.transparentBelowValue),
    alphaGradient: rampStart !== null && rampEnd !== null && rampEnd > rampStart
      ? { rampStartValue: rampStart, rampEndValue: rampEnd, gamma: num(grad?.gamma) ?? 1 }
      : null,
    classes: kind === 'luma8-classified' ? classes : [],
  }
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/** Palette position of a code: 0 at `dataMinCode`, 1 at `dataMaxCode`, clamped. */
export function paletteT(enc: ReleaseEncoding, code: number): number {
  if (enc.kind === 'luma8-classified' && enc.classes.length > 0) {
    // A classified frame carries a handful of exact codes; a lossy codec
    // can move one by a step or two, so snap to the nearest class
    // instead of blending two categories into a colour neither has.
    let nearest = enc.classes[0]!
    for (const c of enc.classes) if (Math.abs(c.code - code) < Math.abs(nearest.code - code)) nearest = c
    code = nearest.code
  }
  const t = (code - enc.dataMinCode) / (enc.dataMaxCode - enc.dataMinCode)
  return Math.min(1, Math.max(0, t))
}

/** The measured value a code stands for, or null for no data. */
export function valueAtCode(enc: ReleaseEncoding, code: number): number | null {
  if (code < enc.nodataThresholdCode) return null
  if (enc.kind === 'luma8-classified' && enc.classes.length > 0) {
    let nearest = enc.classes[0]!
    for (const c of enc.classes) if (Math.abs(c.code - code) < Math.abs(nearest.code - code)) nearest = c
    return nearest.value
  }
  const t = paletteT(enc, code)
  if (enc.kind === 'luma8-log') return enc.vmin * Math.pow(enc.vmax / enc.vmin, t)
  return enc.vmin + t * (enc.vmax - enc.vmin)
}

function paletteAt(stops: readonly ColorScaleStop[], t: number): [number, number, number, number] {
  let i = 0
  while (i < stops.length - 2 && stops[i + 1]!.t < t) i++
  const a = stops[i]!
  const b = stops[i + 1] ?? a
  const span = b.t - a.t
  const f = span > 0 ? Math.min(1, Math.max(0, (t - a.t) / span)) : 0
  return [0, 1, 2, 3].map(c => a.rgba[c]! + (b.rgba[c]! - a.rgba[c]!) * f) as [number, number, number, number]
}

/** Opacity (0..1) the presentation gives a value, before the palette's own alpha. */
function presentationAlpha(enc: ReleaseEncoding, value: number): number {
  if (enc.alphaMode !== 'gradient') return 1
  if (enc.transparentBelowValue !== null && value < enc.transparentBelowValue) return 0
  const g = enc.alphaGradient
  if (!g) return 1
  const f = Math.min(1, Math.max(0, (value - g.rampStartValue) / (g.rampEndValue - g.rampStartValue)))
  return Math.pow(f, g.gamma)
}

/**
 * The exact 256-entry RGBA palette the release describes, indexed by
 * raw luma code — what the VR shader samples with the texture's `.r`.
 */
export function buildReleaseLut(enc: ReleaseEncoding): Uint8Array {
  const lut = new Uint8Array(COLOR_SCALE_LUT_SIZE * 4)
  for (let code = 0; code < COLOR_SCALE_LUT_SIZE; code++) {
    const value = valueAtCode(enc, code)
    if (value === null) continue // no data: fully transparent
    const rgba = paletteAt(enc.stops, paletteT(enc, code))
    const alpha = rgba[3] * presentationAlpha(enc, value)
    const o = code * 4
    lut[o] = Math.round(rgba[0])
    lut[o + 1] = Math.round(rgba[1])
    lut[o + 2] = Math.round(rgba[2])
    lut[o + 3] = Math.round(alpha)
  }
  return lut
}

/**
 * The same palette in the shape the VR globe consumes (`ColorScale`):
 * one stop per code at `t = code / 255`, with no `dataMinLuma` and no
 * `transparentRange`, so `buildColorScaleLut` reproduces
 * {@link buildReleaseLut} entry for entry and the existing
 * data-encoded branch draws it unchanged. `vmin` / `vmax` are the
 * values at codes 0 and 255 on the release's linear axis, so a linear
 * code→value reading stays right across the data codes.
 */
export function releaseColorScale(enc: ReleaseEncoding): ColorScale {
  const lut = buildReleaseLut(enc)
  const stops: ColorScaleStop[] = []
  const top = COLOR_SCALE_LUT_SIZE - 1
  for (let code = 0; code <= top; code++) {
    const o = code * 4
    stops.push({ t: code / top, rgba: [lut[o]!, lut[o + 1]!, lut[o + 2]!, lut[o + 3]!] })
  }
  const slope = (enc.vmax - enc.vmin) / (enc.dataMaxCode - enc.dataMinCode)
  const scale: ColorScale = {
    stops,
    vmin: enc.vmin - enc.dataMinCode * slope,
    vmax: enc.vmin + (top - enc.dataMinCode) * slope,
    // Records "no data below the threshold" for anything that asks the
    // scale (isTransparentLuma). buildColorScaleLut zeroes the same codes
    // the palette already made transparent, so the LUT is unchanged.
    transparentRange: enc.nodataThresholdCode / top,
  }
  if (enc.units) scale.units = enc.units
  return scale
}

/** Where the map sits in the frame in image space (v == 0 is the top row), as the browser globe and the value readout sample it. */
export function releaseCropRect(enc: ReleaseEncoding): { u0: number; v0: number; us: number; vs: number } {
  const { x, y, width, height } = enc.dataRegion
  return { u0: x / enc.frameWidth, v0: y / enc.frameHeight, us: width / enc.frameWidth, vs: height / enc.frameHeight }
}

/** Where the map sits in the frame, in THREE's flipped-Y UV space. */
export function releaseUvRegion(enc: ReleaseEncoding): VrUvRegion {
  const { x, y, width, height } = enc.dataRegion
  return {
    u0: x / enc.frameWidth,
    // Pixel rows count from the top; v counts from the bottom.
    v0: (enc.frameHeight - (y + height)) / enc.frameHeight,
    us: width / enc.frameWidth,
    vs: height / enc.frameHeight,
  }
}

/** A regional release as the overlay's bounding box; null for the whole globe. */
export function releaseBoundingBox(enc: ReleaseEncoding): { n: number; s: number; w: number; e: number } | null {
  const { latTop, latBottom, lonLeft, lonRight } = enc.geo
  const global = latTop >= 90 && latBottom <= -90 && lonRight - lonLeft >= 360
  return global ? null : { n: latTop, s: latBottom, w: lonLeft, e: lonRight }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Follow `latest.json` → `release.json` and return the playable MPD,
 * the release's `.dsa`, and its encoding. URLs inside each file are
 * resolved against that file's own URL, as the publisher writes them
 * relative. Throws with a message naming the step that failed, since a
 * release that cannot be resolved cannot be played at all.
 */
export async function resolveDashRelease(
  latestUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ResolvedRelease> {
  const get = async (url: string, what: string): Promise<Record<string, unknown>> => {
    const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, cache: 'no-cache' })
    if (!res.ok) throw new Error(`${what} ${url} answered ${res.status}`)
    const body = rec(await res.json())
    if (!body) throw new Error(`${what} ${url} is not a JSON object`)
    return body
  }
  const latest = await get(latestUrl, 'Release pointer')
  const pointer = rec(latest.releaseDescriptor)?.url
  if (typeof pointer !== 'string' || !pointer) throw new Error(`Release pointer ${latestUrl} names no release`)
  const releaseUrl = new URL(pointer, latestUrl).toString()
  const release = await get(releaseUrl, 'Release')
  const mpd = rec(release.mpd)?.url
  if (typeof mpd !== 'string' || !mpd) throw new Error(`Release ${releaseUrl} names no MPD`)
  const dsa = rec(release.dsa)?.url
  return {
    mpdUrl: new URL(mpd, releaseUrl).toString(),
    dsaUrl: typeof dsa === 'string' && dsa ? new URL(dsa, releaseUrl).toString() : null,
    encoding: parseReleaseEncoding(release),
  }
}
