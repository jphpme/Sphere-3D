// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const destination = resolve('docs/metadata/schemas/official')
const pending = [
  'https://schemas.stacspec.org/v1.1.0/catalog-spec/json-schema/catalog.json',
  'https://schemas.stacspec.org/v1.1.0/collection-spec/json-schema/collection.json',
  'https://schemas.stacspec.org/v1.1.0/item-spec/json-schema/item.json',
  'https://stac-extensions.github.io/file/v2.1.0/schema.json',
  'https://stac-extensions.github.io/scientific/v1.0.0/schema.json',
]
const allowed = (uri: string) => uri.startsWith('https://schemas.stacspec.org/v1.1.0/')
  || uri.startsWith('https://geojson.org/schema/') || pending.slice(0, 5).includes(uri)
const manifest: { uri: string; file: string; sha256: string }[] = []
await mkdir(destination, { recursive: true })
for (let index = 0; index < pending.length; index++) {
  if (pending.length > 40) throw new Error('Unexpected schema dependency expansion')
  const uri = pending[index]
  if (!allowed(uri)) throw new Error(`Unreviewed schema host: ${uri}`)
  const response = await fetch(uri)
  if (!response.ok) throw new Error(`${response.status}: ${uri}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const schema: unknown = JSON.parse(new TextDecoder().decode(bytes))
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    for (const [key, entry] of Object.entries(value)) {
      if (key === '$ref' && typeof entry === 'string') {
        const target = new URL(entry, uri)
        target.hash = ''
        if (!target.href.startsWith('http://json-schema.org/draft-07/schema') && !pending.includes(target.href)) pending.push(target.href)
      } else visit(entry)
    }
  }
  visit(schema)
  const file = `${index.toString().padStart(2, '0')}-${new URL(uri).pathname.split('/').pop()}`
  await writeFile(resolve(destination, file), bytes)
  manifest.push({ uri, file, sha256: 'sha256:' + createHash('sha256').update(bytes).digest('hex') })
}
await writeFile(resolve(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(`Vendored ${manifest.length} official schemas. Review every digest change before committing.`)