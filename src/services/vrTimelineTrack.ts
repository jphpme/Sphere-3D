// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * In-VR date track - the Three.js half of the shared date strip that says
 * *when* the frame on the globe is and lets the user move through the
 * series.
 *
 * Everything about how the strip *looks* and where a ray lands on it
 * lives in {@link file://./timelineTrackCanvas.ts timelineTrackCanvas.ts},
 * because the 2D playback panel draws the same strip. What is left here
 * is the VR-specific part: a canvas at the strip's 1200 x 220 resolution,
 * a CanvasTexture and a plane to carry it, the visibility flag that tells
 * `vrInteraction` whether to raycast at all, and the signature diff that
 * keeps a per-frame poll from repainting an unchanged frame.
 *
 * The axis itself is parsed in `dsaTimeline.ts` from the stream's `.dsa`;
 * this module is handed the result. `vrSession` positions the mesh below
 * the HUD and above the tour strip, and gates it on the loading handover.
 *
 * See {@link file://./../../docs/VR_PLAYBACK_TRACK_PLAN.md VR_PLAYBACK_TRACK_PLAN.md}.
 */

import type * as THREE from 'three'
import {
  drawTimelineTrack,
  timelineTrackGeometry,
  uvToProgress,
  type TimelineTrackState,
} from './timelineTrackCanvas'

/** World-space size. Matches the HUD's 0.6 m width, a little taller than the tour strip. */
const TRACK_WIDTH = 0.6
const TRACK_HEIGHT = 0.11

/** Canvas resolution. 5.45:1 matches 0.6 x 0.11 m. */
const CANVAS_WIDTH = 1200
const CANVAS_HEIGHT = 220

/** What the track needs to draw one frame of the axis, in the shape the
 *  shared renderer takes. Re-exported so a VR caller imports one module. */
export type VrTimelineState = TimelineTrackState

export interface VrTimelineTrackHandle {
  readonly mesh: THREE.Mesh
  /** Draw a new axis, or hide the strip with `null`. Idempotent. */
  setState(state: VrTimelineState | null): void
  /** True while a timeline is shown -> the strip is visible. Mirror for vrInteraction. */
  isVisible(): boolean
  /** `'timeline'` when the UV is on the bar, else null. */
  hitTest(uv: { x: number; y: number }): 'timeline' | null
  /**
   * Axis position 0 -> 1 for a UV point on the bar, or null when the ray
   * missed it. The caller converts to a date through `dsaTimeline`.
   */
  progressAtUv(uv: { x: number; y: number }): number | null
  dispose(): void
}

export function createVrTimelineTrack(THREE_: typeof THREE): VrTimelineTrackHandle {
  const canvas = document.createElement('canvas')
  canvas.width = CANVAS_WIDTH
  canvas.height = CANVAS_HEIGHT
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('vrTimelineTrack: 2D canvas context unavailable')

  const geometry = timelineTrackGeometry(CANVAS_WIDTH, CANVAS_HEIGHT)

  const texture = new THREE_.CanvasTexture(canvas)
  texture.colorSpace = THREE_.SRGBColorSpace
  texture.minFilter = THREE_.LinearFilter
  texture.magFilter = THREE_.LinearFilter

  const material = new THREE_.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })
  const planeGeometry = new THREE_.PlaneGeometry(TRACK_WIDTH, TRACK_HEIGHT)
  const mesh = new THREE_.Mesh(planeGeometry, material)
  mesh.renderOrder = 10
  mesh.visible = false

  /** Signature of what is on the canvas, so a per-frame poll does not
   *  repaint 1,200 x 220 pixels for an unchanged frame. */
  let drawn = ''
  let visible = false

  function signature(state: VrTimelineState): string {
    const spans = state.availabilitySpans
    return [
      state.startMs,
      state.endMs,
      state.currentMs,
      state.frameCount,
      state.cadenceMs,
      state.scrubbing ? 1 : 0,
      spans.length,
      spans[0]?.startFrame ?? -1,
      spans[spans.length - 1]?.startFrame ?? -1,
    ].join('|')
  }

  const handle: VrTimelineTrackHandle = {
    mesh,

    setState(state) {
      if (!state) {
        visible = false
        mesh.visible = false
        drawn = ''
        return
      }
      mesh.visible = true
      visible = true
      const next = signature(state)
      if (next === drawn) return
      drawn = next
      drawTimelineTrack(ctx, state, geometry)
      texture.needsUpdate = true
    },

    isVisible() {
      return visible
    },

    hitTest(uv) {
      return handle.progressAtUv(uv) === null ? null : 'timeline'
    },

    progressAtUv(uv) {
      if (!visible) return null
      return uvToProgress(uv, geometry)
    },

    dispose() {
      planeGeometry.dispose()
      material.dispose()
      texture.dispose()
    },
  }

  return handle
}
