// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * AYNI — the shape of a value-encoded DASH release's `valueEncoding`,
 * as `services/dashRelease.ts` parses it. Kept in `types/` so
 * `Dataset.vrValueEncoding` can name it without the types folder
 * importing service code (which the Pages Functions and CLI builds,
 * sharing `types/`, cannot compile).
 */

import type { ColorScaleStop } from './color-scale'

export type ReleaseEncodingKind = 'luma8-linear' | 'luma8-log' | 'luma8-classified'

export interface ReleaseClass {
  readonly code: number
  readonly value: number
  readonly label: string
}

/** The parts of `release.json`'s `valueEncoding` the VR globe needs. */
export interface ReleaseEncoding {
  readonly kind: ReleaseEncodingKind
  readonly units: string | null
  readonly vmin: number
  readonly vmax: number
  readonly nodataThresholdCode: number
  readonly dataMinCode: number
  readonly dataMaxCode: number
  /** Map rows within the frame, in pixels from the top-left. */
  readonly dataRegion: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  readonly frameWidth: number
  readonly frameHeight: number
  /** Geographic extent of the data region. */
  readonly geo: { readonly latTop: number; readonly latBottom: number; readonly lonLeft: number; readonly lonRight: number }
  readonly stops: readonly ColorScaleStop[]
  readonly alphaMode: 'gradient' | 'binary' | 'opaque'
  readonly transparentBelowValue: number | null
  readonly alphaGradient: { readonly rampStartValue: number; readonly rampEndValue: number; readonly gamma: number } | null
  readonly classes: readonly ReleaseClass[]
}
