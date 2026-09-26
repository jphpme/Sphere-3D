// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * AYNI — GET /api/layers
 *
 * The basemaps and overlays in the current AYNI catalog release, for the
 * globe's layer stack. Each entry's image is at `/api/layers/file/<sha256>`.
 * 503 without the LAYERS_R2 binding: the client then simply draws no
 * layers, as it did before this endpoint existed.
 */

import { layerList, type LayersEnv } from './_catalog'

export const onRequestGet: PagesFunction<LayersEnv> = async ({ env }) => {
  if (!env.LAYERS_R2) {
    return Response.json({ error: 'layers_unconfigured' }, { status: 503 })
  }
  const list = await layerList(env.LAYERS_R2)
  return Response.json(
    {
      release: list.release,
      layers: list.layers.map(l => ({
        id: l.id,
        title: l.title,
        kind: l.kind,
        url: `/api/layers/file/${l.sha256}`,
        mediaType: l.mediaType,
        bytes: l.bytes,
      })),
    },
    { headers: { 'Cache-Control': 'public, max-age=300' } },
  )
}
