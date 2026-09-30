// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project
/**
 * AYNI — geo-media catalogs (`dsa-geo-media-v1`): places on the globe
 * that each play something live. A radio station is audio, a wildlife
 * cam is a video stream or a still picture fetched again every
 * `refreshSeconds`. The same catalogs drive the desktop apps; this is
 * their reader, with nothing of the page in it.
 */

/** What a marker plays. */
export type GeoMediaKind = 'audio' | 'video' | 'image'

export interface GeoMediaMarker {
  readonly id: string
  readonly title: string
  readonly kind: GeoMediaKind
  readonly longitude: number
  readonly latitude: number
  readonly streamUrl: string
  readonly mimeType?: string
  /** Stills only: seconds between fetches of the picture. */
  readonly refreshSeconds?: number
  /** Cams only: the animals on camera, as one display line. */
  readonly subjects?: string
  readonly description?: string
  readonly location?: string
  readonly country?: string
  /** Who runs the stream, as the catalog asks it to be named. */
  readonly credit?: string
  /** The owner's own page for the stream. */
  readonly sourcePage?: string
  /** False when the catalog's own health check found the source down. */
  readonly online: boolean
}

/** Stills are fetched no faster than this, whatever the catalog asks. */
const MIN_SNAPSHOT_REFRESH_SECONDS = 2
const DEFAULT_SNAPSHOT_REFRESH_SECONDS = 10
const MAX_SNAPSHOT_REFRESH_SECONDS = 600

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** A plain string, or the English (else the first) entry of a `{ lang: text }` record. */
function localizedText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (!isRecord(value)) return ''
  const english = value.en
  if (typeof english === 'string' && english.trim()) return english.trim()
  for (const candidate of Object.values(value)) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return ''
}

function coordinate(value: unknown, min: number, max: number): number | null {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric >= min && numeric <= max ? numeric : null
}

function httpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const url = value.trim()
  return /^https?:\/\//i.test(url) ? url : undefined
}

function kindOf(value: unknown): GeoMediaKind | null {
  return value === 'audio' || value === 'video' || value === 'image' ? value : null
}

export function snapshotRefreshSeconds(value: unknown): number {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_SNAPSHOT_REFRESH_SECONDS
  return Math.min(MAX_SNAPSHOT_REFRESH_SECONDS, Math.max(MIN_SNAPSHOT_REFRESH_SECONDS, seconds))
}

/** True for an HLS playlist, which needs hls.js where the browser has no native HLS. */
export function isHlsUrl(url: string): boolean {
  return /\.m3u8(?:[?#]|$)/i.test(url)
}

/**
 * The catalog's features as markers. A feature this reader can't place
 * or play (no point, no http(s) source, no name) is left out, so one
 * bad row never costs the rest.
 */
export function normalizeGeoMediaCatalog(catalog: unknown): GeoMediaMarker[] {
  if (!isRecord(catalog) || catalog.format !== 'dsa-geo-media-v1' || !Array.isArray(catalog.features)) {
    return []
  }
  const markers: GeoMediaMarker[] = []
  const seen = new Set<string>()
  for (const feature of catalog.features) {
    if (!isRecord(feature) || !isRecord(feature.geometry) || feature.geometry.type !== 'Point') continue
    const coordinates = feature.geometry.coordinates
    if (!Array.isArray(coordinates) || coordinates.length < 2) continue
    const longitude = coordinate(coordinates[0], -180, 180)
    const latitude = coordinate(coordinates[1], -90, 90)
    if (longitude === null || latitude === null) continue

    const media = isRecord(feature.media) ? feature.media : null
    const kind = kindOf(media?.kind)
    if (!media || !kind || !Array.isArray(media.sources)) continue
    const source = media.sources.find(s => isRecord(s) && httpUrl(s.url)) as Record<string, unknown> | undefined
    const streamUrl = httpUrl(source?.url)
    if (!source || !streamUrl) continue

    const title = localizedText(feature.title) || String(feature.id ?? '').trim()
    if (!title) continue
    const id = String(feature.id ?? `${longitude},${latitude},${streamUrl}`).trim()
    if (seen.has(id)) continue
    seen.add(id)

    // Radio features describe their broadcaster as `station`; cams, their place as `site`.
    const place = isRecord(feature.station) ? feature.station : isRecord(feature.site) ? feature.site : {}
    const subject = isRecord(feature.subject) ? feature.subject : {}
    const health = isRecord(feature.health) ? feature.health : {}
    const attribution = isRecord(feature.attribution) ? feature.attribution : {}
    const animals = Array.isArray(subject.animals) ? subject.animals.map(localizedText).filter(Boolean) : []

    markers.push({
      id,
      title,
      kind,
      longitude,
      latitude,
      streamUrl,
      ...(typeof source.mimeType === 'string' ? { mimeType: source.mimeType } : {}),
      ...(kind === 'image' ? { refreshSeconds: snapshotRefreshSeconds(media.refreshSeconds) } : {}),
      ...(kind !== 'audio' && animals.length ? { subjects: animals.join(', ') } : {}),
      description: localizedText(feature.description) || undefined,
      location: localizedText(place.location) || undefined,
      country: localizedText(place.country) || undefined,
      credit: localizedText(attribution.label) || undefined,
      sourcePage: httpUrl(attribution.sourcePage) ?? httpUrl(place.website),
      online: health.online !== false,
    })
  }
  return markers
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export async function fetchGeoMediaMarkers(url: string, fetchImpl: FetchLike = fetch): Promise<GeoMediaMarker[]> {
  const response = await fetchImpl(url, { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`Geo-media catalog request failed: ${response.status} ${response.statusText}`)
  }
  return normalizeGeoMediaCatalog(await response.json())
}

/** Degrees of arc between two places (haversine), for picking the marker nearest a point. */
export function angularDistanceDeg(latA: number, lonA: number, latB: number, lonB: number): number {
  const rad = Math.PI / 180
  const dLat = (latB - latA) * rad
  const dLon = (lonB - lonA) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(latA * rad) * Math.cos(latB * rad) * Math.sin(dLon / 2) ** 2
  return 2 * Math.asin(Math.min(1, Math.sqrt(h))) / rad
}

/** Markers this close share a place: several cams of one zoo. */
const SAME_PLACE_DEG = 0.05

/**
 * The marker a pick at this point means: the one nearest, when it is
 * within `reachDeg`. Markers at one place are picked in turn, so picking
 * the place again moves on from the one that is playing.
 */
export function pickGeoMediaMarker(
  markers: readonly GeoMediaMarker[],
  latitude: number,
  longitude: number,
  reachDeg: number,
  activeId: string | null = null,
): GeoMediaMarker | null {
  let nearest: GeoMediaMarker | null = null
  let nearestDistance = Infinity
  for (const marker of markers) {
    const distance = angularDistanceDeg(latitude, longitude, marker.latitude, marker.longitude)
    if (distance < nearestDistance) {
      nearest = marker
      nearestDistance = distance
    }
  }
  if (!nearest || nearestDistance > reachDeg) return null
  const place = nearest
  const stack = markers.filter(
    m => angularDistanceDeg(place.latitude, place.longitude, m.latitude, m.longitude) <= SAME_PLACE_DEG,
  )
  const active = stack.findIndex(m => m.id === activeId)
  return stack[(active + 1) % stack.length]
}
