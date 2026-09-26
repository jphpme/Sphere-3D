// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * AYNI — the overlay options the immersive globe draws a dataset with:
 * the shared bundle (overlayOptionsFromDataset, which already carries a
 * value-encoded release's palette, crop and decoding rules), plus the
 * map's rectangle in the flipped-Y UV space the THREE shaders sample in.
 * Every other dataset gets exactly the shared bundle. Kept apart from
 * dashRelease.ts so datasetOverlayOptions can use that module without an
 * import cycle.
 */

import type { Dataset } from '../types'
import type { VrOverlayOptions } from './photorealEarth'
import { overlayOptionsFromDataset } from './datasetOverlayOptions'
import { releaseUvRegion } from './dashRelease'

export function vrOverlayOptionsFor(dataset: Dataset): VrOverlayOptions | undefined {
  const shared = overlayOptionsFromDataset(dataset)
  const enc = dataset.releaseEncoding
  if (!enc || !shared) return shared
  return { ...shared, dataRegion: releaseUvRegion(enc) }
}
