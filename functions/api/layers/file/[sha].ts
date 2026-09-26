// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * AYNI — GET /api/layers/file/:sha
 *
 * One layer image from the private catalog bucket. Served only when the
 * hash belongs to a layer in the current release (`isServableLayerFile`);
 * anything else is a 404, so the endpoint cannot be used to read the rest
 * of the catalog. Content-addressed, so the response is immutable.
 */

import { isServableLayerFile, layerList, objectKey, type LayersEnv } from '../_catalog'

export const onRequestGet: PagesFunction<LayersEnv> = async ({ env, params }) => {
  const sha = String(params.sha ?? '').toLowerCase()
  if (!env.LAYERS_R2) return new Response('layers unconfigured', { status: 503 })
  const list = await layerList(env.LAYERS_R2)
  if (!isServableLayerFile(list, sha)) return new Response('not found', { status: 404 })
  const obj = await env.LAYERS_R2.get(objectKey(sha))
  if (!obj) return new Response('not found', { status: 404 })
  const headers = new Headers()
  headers.set('Content-Type', obj.httpMetadata?.contentType ?? list.layers.find(l => l.sha256 === sha)?.mediaType ?? 'application/octet-stream')
  headers.set('Cache-Control', 'public, max-age=31536000, immutable')
  headers.set('ETag', obj.httpEtag)
  headers.set('Access-Control-Allow-Origin', '*')
  return new Response(obj.body, { headers })
}
