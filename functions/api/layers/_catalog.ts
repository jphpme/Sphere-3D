// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * AYNI — the basemaps and overlays the globe can stack around a dataset,
 * read from the signed AYNI catalog (the private `ayni-catalog-production`
 * bucket, bound as LAYERS_R2).
 *
 * The catalog is content-addressed: a release (`targets/channels/stable/
 * <hash>.catalog-release.json`) lists datasets, and each dataset names its
 * `.dsa` descriptor and media files by sha256. The layers are the
 * `builtin-*` datasets — relief-bathymetry, coastlines, graticule, … —
 * and a layer is a basemap when its descriptor's `composition.roles`
 * says `base`, an overlay otherwise.
 *
 * Only those layers' images are ever served (`isServableLayerFile`): the
 * bucket also carries the desktop apps' catalog, which has its own
 * delivery path, and knowing a hash is not a reason to hand its file out.
 */

export interface LayersEnv {
  LAYERS_R2?: R2Bucket
}

export type LayerKind = 'basemap' | 'overlay'

export interface CatalogLayer {
  /** The catalog dataset id, e.g. `builtin-nasa-relief-bathymetry`. */
  id: string
  title: string
  kind: LayerKind
  /** sha256 of the image; the file is served at `/api/layers/file/<sha>`. */
  sha256: string
  mediaType: string
  bytes: number
}

export interface LayerList {
  release: string | null
  layers: CatalogLayer[]
}

const RELEASE_PREFIX = 'targets/channels/stable/'
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const SHA256_RE = /^[0-9a-f]{64}$/

/** The R2 key of a content-addressed catalog object. */
export function objectKey(sha256: string): string {
  return `targets/objects/catalog/sha256/${sha256}.${sha256}`
}

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function localized(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim()
  const r = rec(v)
  if (!r) return null
  const en = r.en
  if (typeof en === 'string' && en.trim()) return en.trim()
  const first = Object.values(r).find(x => typeof x === 'string' && x.trim())
  return typeof first === 'string' ? first.trim() : null
}

/** The newest release in the stable channel, by upload time. */
async function newestReleaseKey(bucket: R2Bucket): Promise<string | null> {
  let newest: { key: string; uploaded: number } | null = null
  let cursor: string | undefined
  do {
    const page = await bucket.list({ prefix: RELEASE_PREFIX, cursor })
    for (const o of page.objects) {
      if (!o.key.endsWith('.catalog-release.json')) continue
      const uploaded = o.uploaded.getTime()
      if (!newest || uploaded > newest.uploaded) newest = { key: o.key, uploaded }
    }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return newest?.key ?? null
}

async function readJson(bucket: R2Bucket, key: string): Promise<unknown> {
  const obj = await bucket.get(key)
  if (!obj) return null
  try {
    return await obj.json()
  } catch {
    return null
  }
}

/**
 * The layers in the newest stable release. A layer dataset with no image
 * artifact, or whose descriptor is missing, is left out rather than
 * guessed at.
 */
export async function readLayerList(bucket: R2Bucket): Promise<LayerList> {
  const releaseKey = await newestReleaseKey(bucket)
  if (!releaseKey) return { release: null, layers: [] }
  const release = rec(await readJson(bucket, releaseKey))
  const datasets = Array.isArray(release?.datasets) ? release!.datasets : []

  const layers = await Promise.all(datasets.map(async (raw): Promise<CatalogLayer | null> => {
    const d = rec(raw)
    const id = typeof d?.id === 'string' ? d.id : ''
    if (!id.startsWith('builtin-')) return null
    const image = (Array.isArray(d!.artifacts) ? d!.artifacts : [])
      .map(rec)
      .find(a => a && typeof a.sha256 === 'string' && SHA256_RE.test(a.sha256) && IMAGE_TYPES.has(String(a.mediaType)))
    if (!image) return null
    const descriptorSha = rec(d!.descriptor)?.sha256
    const dsa = typeof descriptorSha === 'string' && SHA256_RE.test(descriptorSha)
      ? rec(await readJson(bucket, objectKey(descriptorSha)))
      : null
    if (!dsa) return null
    const roles = rec(dsa.composition)?.roles
    const isBase = Array.isArray(roles) && roles.includes('base')
    return {
      id,
      title: localized(dsa.title) ?? id,
      kind: isBase ? 'basemap' : 'overlay',
      sha256: image.sha256 as string,
      mediaType: String(image.mediaType),
      bytes: typeof image.length === 'number' ? image.length : 0,
    }
  }))

  const releaseId = typeof release?.releaseId === 'string' ? release.releaseId : null
  return {
    release: releaseId,
    layers: layers.filter((l): l is CatalogLayer => l !== null).sort((a, b) => a.id.localeCompare(b.id)),
  }
}

/**
 * The list, remembered per isolate for a few minutes: every page load asks
 * for it, while the catalog changes when Pachamama Studios publishes a
 * release. `now` and the store are parameters so tests can drive expiry.
 */
const TTL_MS = 5 * 60 * 1000
let cached: { at: number; list: LayerList } | null = null

export async function layerList(bucket: R2Bucket, now = Date.now()): Promise<LayerList> {
  if (cached && now - cached.at < TTL_MS) return cached.list
  const list = await readLayerList(bucket)
  cached = { at: now, list }
  return list
}

/** For tests: forget the remembered list. */
export function resetLayerListCache(): void {
  cached = null
}

/** True only for the image of a layer in the current list. */
export function isServableLayerFile(list: LayerList, sha256: string): boolean {
  return SHA256_RE.test(sha256) && list.layers.some(l => l.sha256 === sha256)
}
