// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { catalogOrigin, geoMediaDatasets, resolveGeoMediaCatalogOrigin, type GeoMediaSwitchEnv } from './geoMediaSwitch'

// The switch pins the SHA-256 of the real catalog origin; the tests never
// spell that origin out and instead teach the digest to answer for a
// stand-in, so this file stays free of the address too.
const ALLOWED = 'https://catalog.allowed.test'
const PINNED_HASH = '889182ff98bb8c0072cad87e9ca14fbc907b204598a8736c4f0d5ee8347b7754'
const digest = async (text: string): Promise<string> =>
  text === ALLOWED ? PINNED_HASH : createHash('sha256').update(text).digest('hex')

function env(search: string, stored: Record<string, string> = {}): GeoMediaSwitchEnv & { stored: Record<string, string> } {
  return {
    search,
    stored,
    storage: {
      getItem: key => stored[key] ?? null,
      setItem: (key, value) => { stored[key] = value },
      removeItem: key => { delete stored[key] },
    },
    digest,
  }
}

describe('catalogOrigin', () => {
  it('takes a bare host, a host with a path, or a URL, and keeps only the https origin', () => {
    expect(catalogOrigin('catalog.allowed.test')).toBe(ALLOWED)
    expect(catalogOrigin(' catalog.allowed.test/v1/catalog ')).toBe(ALLOWED)
    expect(catalogOrigin('https://catalog.allowed.test/v1/catalog?x=1')).toBe(ALLOWED)
  })

  it('refuses anything that is not https', () => {
    expect(catalogOrigin('http://catalog.allowed.test')).toBeNull()
    expect(catalogOrigin('javascript:alert(1)')).toBeNull()
    expect(catalogOrigin('')).toBeNull()
  })
})

describe('resolveGeoMediaCatalogOrigin', () => {
  it('is off with nothing in the address or the storage', async () => {
    await expect(resolveGeoMediaCatalogOrigin(env(''))).resolves.toBeNull()
  })

  it('turns on for the allowed host and remembers it', async () => {
    const e = env('?geoMedia=catalog.allowed.test')
    await expect(resolveGeoMediaCatalogOrigin(e)).resolves.toBe(ALLOWED)
    expect(e.stored['ayni-geo-media-catalog']).toBe(ALLOWED)
    await expect(resolveGeoMediaCatalogOrigin(env('', e.stored))).resolves.toBe(ALLOWED)
  })

  it('ignores a link carrying some other host, and keeps what was stored', async () => {
    const e = env('?geoMedia=evil.example', { 'ayni-geo-media-catalog': ALLOWED })
    await expect(resolveGeoMediaCatalogOrigin(e)).resolves.toBe(ALLOWED)
    await expect(resolveGeoMediaCatalogOrigin(env('?geoMedia=evil.example'))).resolves.toBeNull()
  })

  it('does not trust a stored value that is not allowed either', async () => {
    await expect(resolveGeoMediaCatalogOrigin(env('', { 'ayni-geo-media-catalog': 'https://evil.example' }))).resolves.toBeNull()
  })

  it('turns off on request and forgets the host', async () => {
    const e = env('?geoMedia=off', { 'ayni-geo-media-catalog': ALLOWED })
    await expect(resolveGeoMediaCatalogOrigin(e)).resolves.toBeNull()
    expect(e.stored['ayni-geo-media-catalog']).toBeUndefined()
  })

  it('stays off without a digest or a storage', async () => {
    await expect(resolveGeoMediaCatalogOrigin({ search: '?geoMedia=catalog.allowed.test', storage: null, digest: null })).resolves.toBeNull()
    await expect(resolveGeoMediaCatalogOrigin({ search: '?geoMedia=catalog.allowed.test', storage: null, digest })).resolves.toBe(ALLOWED)
  })
})

describe('geoMediaDatasets', () => {
  it('names the two catalogs under the origin', () => {
    const rows = geoMediaDatasets(ALLOWED)
    expect(rows.map(r => r.id)).toEqual(['GEO_MEDIA_wildlife-cams', 'GEO_MEDIA_radio'])
    expect(rows.every(r => r.format === 'geo-media/json')).toBe(true)
    expect(rows.map(r => r.dataLink)).toEqual([`${ALLOWED}/v1/catalogs/wildlife-cams`, `${ALLOWED}/v1/catalog`])
  })
})
