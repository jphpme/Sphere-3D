// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project
/**
 * AYNI — the private switch for the geo-media datasets (wildlife cams,
 * radio). They are not public: permission to show the cams has not been
 * asked of their owners, so the site lists them on no device that was
 * not given the catalog's address by hand.
 *
 * Opening the site once with `?geoMedia=<catalog host>` turns them on
 * for that browser, `?geoMedia=off` turns them off again. The address
 * is kept in localStorage and appears nowhere in this source: only its
 * SHA-256 does, so a link carrying some other host cannot make the site
 * list someone else's streams as its own.
 */
import type { Dataset } from '../types'

export const GEO_MEDIA_FORMAT = 'geo-media/json'

const PARAM = 'geoMedia'
const STORAGE_KEY = 'ayni-geo-media-catalog'

/** SHA-256 (hex) of each catalog origin this site will read. */
const ALLOWED_ORIGIN_HASHES: readonly string[] = [
  '889182ff98bb8c0072cad87e9ca14fbc907b204598a8736c4f0d5ee8347b7754',
]

export interface GeoMediaSwitchEnv {
  search: string
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null
  digest: ((text: string) => Promise<string>) | null
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('')
}

function browserEnv(): GeoMediaSwitchEnv {
  let storage: Storage | null = null
  try { storage = window.localStorage } catch { /* blocked: the switch stays off */ }
  return {
    search: typeof location !== 'undefined' ? location.search : '',
    storage,
    // Not there on an insecure origin, where nothing here should run anyway.
    digest: typeof crypto !== 'undefined' && crypto.subtle ? sha256Hex : null,
  }
}

/** `host`, `host/path` or a full URL, as the https origin it names; null for anything else. */
export function catalogOrigin(value: string): string | null {
  const text = value.trim()
  if (!text) return null
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`)
    return url.protocol === 'https:' ? url.origin : null
  } catch {
    return null
  }
}

async function allowed(origin: string, env: GeoMediaSwitchEnv): Promise<boolean> {
  if (!env.digest) return false
  try {
    return ALLOWED_ORIGIN_HASHES.includes(await env.digest(origin))
  } catch {
    return false
  }
}

/**
 * The catalog origin this browser was given, or null while the switch
 * is off. Reads the page address first, so a visit with the parameter
 * takes effect on that same load.
 */
export async function resolveGeoMediaCatalogOrigin(env: GeoMediaSwitchEnv = browserEnv()): Promise<string | null> {
  const param = new URLSearchParams(env.search).get(PARAM)
  if (param !== null) {
    if (/^(?:off|0|false)$/i.test(param.trim())) {
      try { env.storage?.removeItem(STORAGE_KEY) } catch { /* nothing to forget */ }
      return null
    }
    const origin = catalogOrigin(param)
    if (origin && await allowed(origin, env)) {
      try { env.storage?.setItem(STORAGE_KEY, origin) } catch { /* on for this visit only */ }
      return origin
    }
  }
  let stored: string | null = null
  try { stored = env.storage?.getItem(STORAGE_KEY) ?? null } catch { /* blocked */ }
  const origin = stored ? catalogOrigin(stored) : null
  return origin && await allowed(origin, env) ? origin : null
}

/**
 * Take the switch parameter out of the address bar once it has been
 * read, so a copied link or a screenshot does not carry the catalog's
 * address along.
 */
export function stripGeoMediaParam(): void {
  if (typeof location === 'undefined' || typeof history === 'undefined') return
  const url = new URL(location.href)
  if (!url.searchParams.has(PARAM)) return
  url.searchParams.delete(PARAM)
  history.replaceState(history.state, '', url.pathname + url.search + url.hash)
}

/** The two geo-media datasets, as catalog rows read from `origin`. */
export function geoMediaDatasets(origin: string): Dataset[] {
  return [
    {
      id: 'GEO_MEDIA_wildlife-cams',
      title: 'Global Wildlife Cams',
      format: GEO_MEDIA_FORMAT,
      dataLink: `${origin}/v1/catalogs/wildlife-cams`,
      organization: 'Pachamama Studios',
      abstractTxt:
        'Live wildlife cameras around the world: nests, waterholes, reefs and feeding stations. ' +
        'Pick a dot on the globe to watch. Some cameras send live video, others a picture that renews every few seconds or minutes. ' +
        'Private test: permission to show these cameras has not been asked of their owners yet, so this dataset is not listed publicly.',
      tags: ['Live', 'Wildlife'],
      weight: 48,
      thumbnailLink: '',
    },
    {
      id: 'GEO_MEDIA_radio',
      title: 'Global Radio Garden',
      format: GEO_MEDIA_FORMAT,
      dataLink: `${origin}/v1/catalog`,
      organization: 'Pachamama Studios',
      abstractTxt:
        'Live radio stations around the world. Pick a dot on the globe to listen to what is on air there right now. ' +
        'Private test: not listed publicly.',
      tags: ['Live', 'Radio'],
      weight: 47,
      thumbnailLink: '',
    },
  ]
}

export function isGeoMediaDataset(dataset: Pick<Dataset, 'format'>): boolean {
  return dataset.format === GEO_MEDIA_FORMAT
}
