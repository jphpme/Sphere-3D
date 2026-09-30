// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project
import { describe, expect, it } from 'vitest'
import { angularDistanceDeg, isHlsUrl, normalizeGeoMediaCatalog, pickGeoMediaMarker, snapshotRefreshSeconds } from './geoMedia'

const radio = {
  id: 'st-1',
  title: { en: 'Exclusiv Kraftwerk' },
  description: { en: 'Dubai. MP3, 128 kbps.' },
  geometry: { type: 'Point', coordinates: [55.1885, 25.0743] },
  media: { kind: 'audio', live: true, sources: [{ url: 'https://streaming.example/kraftwerk', transport: 'http', mimeType: 'audio/mpeg' }] },
  station: { location: { en: 'Dubai' }, country: { en: 'The United Arab Emirates' }, website: 'https://you.radio/kraftwerk' },
  attribution: { label: 'Exclusiv Kraftwerk', sourcePage: 'https://you.radio/kraftwerk' },
}

const cam = {
  id: 'alfeld-storchcam',
  title: { en: 'Alfeld Storchcam' },
  geometry: { type: 'Point', coordinates: [9.826, 51.986] },
  media: { kind: 'image', refreshSeconds: 60, sources: [{ url: 'https://relay.example/v1/cams/alfeld/snapshot', mimeType: 'image/jpeg' }] },
  site: { location: { en: 'Alfeld (Leine), Niedersachsen' }, country: { en: 'Germany' }, website: 'https://www.alfeld.de/storchcam' },
  subject: { animals: ['white stork'], habitat: 'nest' },
  attribution: { label: 'Stadt Alfeld (Leine)', sourcePage: 'https://www.alfeld.de/storchcam' },
  health: { online: false, checkedAt: '2026-09-30T16:00:27.600Z' },
}

const catalog = (features: unknown[]) => ({ format: 'dsa-geo-media-v1', version: '1', features })

describe('normalizeGeoMediaCatalog', () => {
  it('reads a radio station: place from `station`, no subjects, online by default', () => {
    const [m] = normalizeGeoMediaCatalog(catalog([radio]))
    expect(m).toMatchObject({
      id: 'st-1', title: 'Exclusiv Kraftwerk', kind: 'audio', longitude: 55.1885, latitude: 25.0743,
      streamUrl: 'https://streaming.example/kraftwerk', mimeType: 'audio/mpeg',
      location: 'Dubai', country: 'The United Arab Emirates', credit: 'Exclusiv Kraftwerk', sourcePage: 'https://you.radio/kraftwerk',
      online: true,
    })
    expect(m.subjects).toBeUndefined()
    expect(m.refreshSeconds).toBeUndefined()
  })

  it('reads a snapshot cam: place from `site`, animals, refresh, and the health check', () => {
    const [m] = normalizeGeoMediaCatalog(catalog([cam]))
    expect(m).toMatchObject({
      kind: 'image', refreshSeconds: 60, subjects: 'white stork', location: 'Alfeld (Leine), Niedersachsen',
      country: 'Germany', credit: 'Stadt Alfeld (Leine)', online: false,
    })
  })

  it('falls back to the site website when there is no attribution page', () => {
    const [m] = normalizeGeoMediaCatalog(catalog([{ ...cam, attribution: { label: 'Stadt Alfeld' } }]))
    expect(m.sourcePage).toBe('https://www.alfeld.de/storchcam')
  })

  it('leaves out what it cannot place or play, and keeps the rest', () => {
    const rows = normalizeGeoMediaCatalog(catalog([
      { ...radio, id: 'no-point', geometry: { type: 'Polygon', coordinates: [] } },
      { ...radio, id: 'bad-lat', geometry: { type: 'Point', coordinates: [10, 95] } },
      { ...radio, id: 'ftp', media: { kind: 'audio', sources: [{ url: 'ftp://x' }] } },
      { ...radio, id: 'no-kind', media: { sources: [{ url: 'https://x' }] } },
      { ...radio, id: 'untitled', title: '' },
      { ...radio, id: '', title: '' },
      { ...radio, id: 'dup' }, { ...radio, id: 'dup' },
      radio,
    ]))
    // An untitled feature is named by its id; one without either is nothing to pick.
    expect(rows.map(r => r.id)).toEqual(['untitled', 'dup', 'st-1'])
    expect(rows[0].title).toBe('untitled')
  })

  it('takes the first http(s) source, skipping others', () => {
    const [m] = normalizeGeoMediaCatalog(catalog([{
      ...radio, media: { kind: 'audio', sources: [{ url: 'rtsp://cam' }, { url: 'https://ok.example/a.m3u8' }] },
    }]))
    expect(m.streamUrl).toBe('https://ok.example/a.m3u8')
  })

  it('is empty for anything that is not a dsa-geo-media-v1 catalog', () => {
    expect(normalizeGeoMediaCatalog(null)).toEqual([])
    expect(normalizeGeoMediaCatalog({ format: 'geojson', features: [radio] })).toEqual([])
    expect(normalizeGeoMediaCatalog({ format: 'dsa-geo-media-v1' })).toEqual([])
  })
})

describe('snapshotRefreshSeconds', () => {
  it('clamps to 2..600 s and defaults to 10 s', () => {
    expect(snapshotRefreshSeconds(60)).toBe(60)
    expect(snapshotRefreshSeconds(0.5)).toBe(2)
    expect(snapshotRefreshSeconds(3600)).toBe(600)
    expect(snapshotRefreshSeconds(undefined)).toBe(10)
    expect(snapshotRefreshSeconds('abc')).toBe(10)
  })
})

describe('isHlsUrl', () => {
  it('recognises a playlist, with or without a query', () => {
    expect(isHlsUrl('https://s.example/live/playlist.m3u8')).toBe(true)
    expect(isHlsUrl('https://s.example/live/index.M3U8?token=1')).toBe(true)
    expect(isHlsUrl('https://s.example/stream.mp3')).toBe(false)
    expect(isHlsUrl('https://s.example/m3u8/notreally')).toBe(false)
  })
})

describe('pickGeoMediaMarker', () => {
  const at = (id: string, latitude: number, longitude: number) => ({
    id, title: id, kind: 'audio' as const, latitude, longitude, streamUrl: 'https://x', online: true,
  })
  const markers = [at('a', 10, 10), at('b', 10.01, 10.01), at('c', 40, 40)]

  it('finds the nearest within reach, else nothing', () => {
    expect(pickGeoMediaMarker(markers, 40.5, 40, 1)?.id).toBe('c')
    expect(pickGeoMediaMarker(markers, 40.5, 40, 0.2)).toBeNull()
    expect(pickGeoMediaMarker([], 0, 0, 90)).toBeNull()
  })

  it('cycles through the markers that share a place', () => {
    expect(pickGeoMediaMarker(markers, 10, 10, 1, null)?.id).toBe('a')
    expect(pickGeoMediaMarker(markers, 10, 10, 1, 'a')?.id).toBe('b')
    expect(pickGeoMediaMarker(markers, 10, 10, 1, 'b')?.id).toBe('a')
  })

  it('measures arc, not a flat difference', () => {
    expect(angularDistanceDeg(0, 0, 0, 90)).toBeCloseTo(90, 6)
    expect(angularDistanceDeg(89, 0, 89, 180)).toBeCloseTo(2, 6)
  })
})
