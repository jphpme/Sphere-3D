// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * AYNI — write `public/ayni-xr-anchor.svg`, the shared-AR marker to print
 * or to show on a spare screen (`docs/SHARED_AR_PLAN.md`).
 *
 * The layout comes from `src/services/sharedMarker.ts`, the module the
 * detector reads, and the mark in the middle from
 * `public/ayni-xr-mark.svg`. The file is committed; `--check` compares it
 * with a fresh render, and `scripts/build-anchor-marker.test.ts` runs that
 * comparison in the test suite, so the artwork cannot drift from the code
 * that looks for it.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildMarkerSvg } from '../src/services/sharedMarker'

const HERE = resolve(fileURLToPath(import.meta.url), '..')
const REPO_ROOT = resolve(HERE, '..')
const MARK = resolve(REPO_ROOT, 'public/ayni-xr-mark.svg')
export const OUTPUT = resolve(REPO_ROOT, 'public/ayni-xr-anchor.svg')

/** The marker file's contents, from the sources on disk. */
export function renderAnchorMarker(): string {
  return buildMarkerSvg(readFileSync(MARK, 'utf8'))
}

function main(): void {
  const rendered = renderAnchorMarker()
  if (process.argv.includes('--check')) {
    if (readFileSync(OUTPUT, 'utf8') !== rendered) {
      console.error('public/ayni-xr-anchor.svg is stale: run `npm run build:anchor-marker`')
      process.exit(1)
    }
    return
  }
  writeFileSync(OUTPUT, rendered)
  console.log(`✓ Wrote ${OUTPUT}`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
