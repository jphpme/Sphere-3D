// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import { buildStacCatalog, buildStacGeometry, buildStacProduct, sha256Multihash, stacEtagInput } from './stac-builders'
import { stacFixture } from './stac-test-helpers'

describe('pure STAC builders', () => {
  it('builds an identity-only root without reading private profile prose', async () => {
    const { node, resolvers } = await stacFixture()
    node.identity.description = 'Public node description'
    expect(buildStacCatalog(node, resolvers)).toMatchObject({ ok: true, value: { description: 'Public node description', stac_extensions: [] } })
    node.identity.description = null
    expect(buildStacCatalog(node, resolvers)).toMatchObject({ ok: true, value: { description: 'Scientific data catalog for ' + node.identity.display_name + '.' } })
  })

  it('builds deterministic linked resources and separates data from manifest', async () => {
    const { model, node, resolvers } = await stacFixture()
    const built = buildStacProduct(model, node, resolvers)
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.value.collection?.id).toBe(`NODE000-${model.row.id}`)
    expect(built.value.item).toMatchObject({ id: model.row.id, properties: { datetime: null, start_datetime: model.row.start_time, end_datetime: model.row.end_time }, assets: { data: { type: 'image/png', href: 'https://data.example/image.png' }, manifest: { type: 'application/json', roles: ['metadata'] } } })
    model.row.slug = 'renamed'
    expect(buildStacProduct(model, node, resolvers)).toEqual(built)
    expect(stacEtagInput(built.value.item!)).toBe(stacEtagInput(structuredClone(built.value.item!)))
  })

  it('supports honest unknown geometry and open collection time', async () => {
    const { model, node, resolvers } = await stacFixture()
    model.row.bbox_provenance = 'unknown'
    expect(buildStacProduct(model, node, resolvers)).toMatchObject({ ok: true, value: { collection: null, item: { geometry: null } } })
    model.row.bbox_provenance = 'measured'
    model.row.temporal_semantics = 'unknown'
    expect(buildStacProduct(model, node, resolvers)).toMatchObject({ ok: true, value: { item: null, collection: { extent: { temporal: { interval: [[null, null]] } }, assets: { data: { type: 'image/png' } } } } })
  })

  it('splits antimeridian rings and does not invent bundle or upload hashes', () => {
    expect(buildStacGeometry({ n: 20, s: -20, w: 170, e: -170 })).toMatchObject({ bbox: [170, -20, -170, 20], geometry: { type: 'MultiPolygon', coordinates: [expect.any(Array), expect.any(Array)] } })
    expect(buildStacGeometry(null)).toEqual({ geometry: null })
    expect(sha256Multihash(`sha256:${'a'.repeat(64)}`)).toBe(`1220${'a'.repeat(64)}`)
    expect(sha256Multihash('sha256:wrong')).toBeNull()
  })

  it('requires current reviewed selections and never falls back to private draft fields', async () => {
    const { node, resolvers } = await stacFixture()
    node.identity.description = null
    node.publicSelection = { nodeId: node.identity.node_id, revision: 1, selectedValues: { mission: 'Approved mission' }, approval: { authorId: 'author', authorRole: 'admin', reviewerId: 'reviewer', reviewerRole: 'service', changeId: 'change', reason: 'Public selection' } }
    expect(buildStacCatalog(node, resolvers)).not.toMatchObject({ value: { description: 'Approved mission' } })
    node.policyCurrent = true
    expect(buildStacCatalog(node, resolvers)).toMatchObject({ ok: true, value: { description: 'Approved mission' } })
    node.publicSelection.selectedValues = {}
    expect(buildStacCatalog(node, resolvers)).toMatchObject({ ok: true, value: { description: `Scientific data catalog for ${node.identity.display_name}.` } })
  })

  it('omits unknown optional custom fields and withholds essential ones', async () => {
    const { model, node, resolvers } = await stacFixture()
    model.customFields = [{ key: 'lab:code', value: 'hidden', scope: 'Item', ownerNodeId: 'LAB', essential: false }]
    expect(buildStacProduct(model, node, resolvers)).toMatchObject({ ok: true, reasons: expect.arrayContaining(['unknown_prefix']) })
    model.customFields[0].essential = true
    expect(buildStacProduct(model, node, resolvers)).toEqual({ ok: false, reasons: ['unknown_prefix'] })
  })
})