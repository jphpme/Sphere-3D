// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { beforeEach, describe, expect, it } from 'vitest'
import { isServableLayerFile, layerList, objectKey, readLayerList, resetLayerListCache } from './_catalog'
import { onRequestGet as getList } from './index'
import { onRequestGet as getFile } from './file/[sha]'

const sha = (c: string) => c.repeat(64)
const RELIEF = sha('a')
const RELIEF_DSA = sha('b')
const COAST = sha('c')
const COAST_DSA = sha('d')
const SECRET = sha('e') // a non-layer catalog object

/** A minimal stand-in for the R2 bucket, shaped like ayni-catalog-production. */
function fakeBucket(objects: Record<string, { body: unknown; uploaded?: number; contentType?: string }>) {
  const entries = Object.entries(objects)
  const toObject = (key: string) => {
    const o = objects[key]!
    const text = typeof o.body === 'string' ? o.body : JSON.stringify(o.body)
    return {
      key,
      uploaded: new Date(o.uploaded ?? 0),
      httpEtag: `"${key.length}"`,
      httpMetadata: { contentType: o.contentType },
      body: text,
      json: async () => JSON.parse(text),
    }
  }
  return {
    list: async ({ prefix }: { prefix: string }) => ({
      objects: entries.filter(([k]) => k.startsWith(prefix)).map(([k]) => toObject(k)),
      truncated: false,
    }),
    get: async (key: string) => (objects[key] ? toObject(key) : null),
  } as unknown as R2Bucket
}

function release(id: string, datasets: unknown[]) {
  return { releaseId: id, datasets }
}

const LAYER_DATASETS = [
  {
    id: 'builtin-nasa-relief-bathymetry',
    descriptor: { sha256: RELIEF_DSA },
    artifacts: [{ sha256: RELIEF, mediaType: 'image/jpeg', length: 283_000 }],
  },
  {
    id: 'builtin-nasa-coastlines',
    descriptor: { sha256: COAST_DSA },
    artifacts: [{ sha256: COAST, mediaType: 'image/png', length: 185_000 }],
  },
  // An ordinary catalog dataset: never a layer, never served.
  { id: 'c07ce84ab9651a13', descriptor: { sha256: sha('f') }, artifacts: [{ sha256: SECRET, mediaType: 'image/png', length: 1 }] },
]

function bucket() {
  return fakeBucket({
    'targets/channels/stable/old.catalog-release.json': { body: release('catalog-old', []), uploaded: 1 },
    'targets/channels/stable/new.catalog-release.json': { body: release('catalog-new', LAYER_DATASETS), uploaded: 2 },
    [objectKey(RELIEF_DSA)]: { body: { title: { en: 'NASA Relief and Bathymetry' }, composition: { roles: ['base'] } } },
    [objectKey(COAST_DSA)]: { body: { title: { en: 'Global Coastlines' }, composition: { roles: ['overlay'] } } },
    [objectKey(RELIEF)]: { body: 'jpeg-bytes', contentType: 'image/jpeg' },
    [objectKey(COAST)]: { body: 'png-bytes', contentType: 'image/png' },
    [objectKey(SECRET)]: { body: 'not for the web', contentType: 'image/png' },
  })
}

beforeEach(() => resetLayerListCache())

describe('readLayerList', () => {
  it('reads the builtin layers of the newest stable release, basemap or overlay by role', async () => {
    const list = await readLayerList(bucket())
    expect(list.release).toBe('catalog-new')
    expect(list.layers).toEqual([
      { id: 'builtin-nasa-coastlines', title: 'Global Coastlines', kind: 'overlay', sha256: COAST, mediaType: 'image/png', bytes: 185_000 },
      { id: 'builtin-nasa-relief-bathymetry', title: 'NASA Relief and Bathymetry', kind: 'basemap', sha256: RELIEF, mediaType: 'image/jpeg', bytes: 283_000 },
    ])
  })

  it('is empty when the channel has no release', async () => {
    expect(await readLayerList(fakeBucket({}))).toEqual({ release: null, layers: [] })
  })

  it('remembers the list for a few minutes', async () => {
    const b = bucket()
    const first = await layerList(b, 0)
    expect(await layerList(fakeBucket({}), 60_000)).toBe(first)
    expect((await layerList(fakeBucket({}), 10 * 60_000)).layers).toEqual([])
  })
})

describe('isServableLayerFile', () => {
  it('serves layer images and nothing else in the catalog', async () => {
    const list = await readLayerList(bucket())
    expect(isServableLayerFile(list, RELIEF)).toBe(true)
    expect(isServableLayerFile(list, SECRET)).toBe(false)
    expect(isServableLayerFile(list, RELIEF_DSA)).toBe(false)
    expect(isServableLayerFile(list, '../../metadata/root.json')).toBe(false)
  })
})

describe('GET /api/layers', () => {
  it('lists the layers with the URL each image is served at', async () => {
    const res = await getList({ env: { LAYERS_R2: bucket() } } as never)
    const body = await res.json() as { layers: Array<{ id: string; url: string; kind: string }> }
    expect(body.layers.map(l => [l.id, l.kind, l.url])).toEqual([
      ['builtin-nasa-coastlines', 'overlay', `/api/layers/file/${COAST}`],
      ['builtin-nasa-relief-bathymetry', 'basemap', `/api/layers/file/${RELIEF}`],
    ])
  })

  it('answers 503 without the bucket binding', async () => {
    const res = await getList({ env: {} } as never)
    expect(res.status).toBe(503)
  })
})

describe('GET /api/layers/file/:sha', () => {
  it('serves a layer image, immutably', async () => {
    const res = await getFile({ env: { LAYERS_R2: bucket() }, params: { sha: COAST } } as never)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/png')
    expect(res.headers.get('Cache-Control')).toContain('immutable')
    expect(await res.text()).toBe('png-bytes')
  })

  it('refuses any other catalog object, even by its exact hash', async () => {
    const res = await getFile({ env: { LAYERS_R2: bucket() }, params: { sha: SECRET } } as never)
    expect(res.status).toBe(404)
  })
})
