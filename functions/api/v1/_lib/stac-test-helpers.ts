// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { asD1, seedFixtures } from './test-helpers'
import { readStacModel } from './stac-read-model'
import type { StacResolvers } from './stac-builders'

export async function stacFixture() {
  const sqlite = seedFixtures({ count: 1 })
  try {
    sqlite.exec(`UPDATE datasets SET origin_node='NODE000',
      data_ref='url:https://data.example/image.png', format='image/png',
      resource_kind='product', bbox_provenance='measured', bbox_evidence='Source metadata',
      bbox_n=30, bbox_s=-30, bbox_w=-60, bbox_e=60,
      temporal_semantics='represented', temporal_evidence='Source metadata',
      start_time='2026-01-01T00:00:00Z', end_time='2026-01-02T00:00:00Z', license_spdx='CC-BY-4.0'`)
    const model = await readStacModel(asD1(sqlite))
    model.datasets[0].row.id = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
    const node = model.node!
    node.identity.node_id = 'NODE000'
    const resolvers: StacResolvers = {
      resource: (kind, id) => `https://node.example/${kind}/${encodeURIComponent(id)}`,
      asset: ref => ref.startsWith('url:https://data.example/') ? { sourceRef: ref, href: ref.slice(4), type: 'image/png', anonymous: true, hostedBy: 'NODE000' } : null,
    }
    return { node, model: model.datasets[0], resolvers }
  } finally { sqlite.close() }
}