// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * AYNI — the layer stack's overlays on the immersive globe: one thin
 * transparent shell per overlay (country borders, coastlines, grids,
 * labels), drawn just outside the globe surface over whatever the
 * dataset shows. The browser globe draws the same overlays as passes in
 * earthTileLayer; `mapLayers.ts` decides which.
 *
 * The shells are children of the globe mesh, so they follow its
 * position, rotation and placement scale with no per-frame work. The
 * material is vrBorders' — premultiplied alpha, depth-tested so lines on
 * the far side of the sphere stay hidden, double-sided for a user who
 * steps inside — plus a tint that redraws line art in white or black.
 */

import type * as THREE from 'three'
import type { MapLayerTint } from './earthTileLayer'

/** Just outside vrBorders' 1.001 shell, then a hair further out per layer. */
const BASE_RADIUS_FACTOR = 1.0015
const STEP_RADIUS_FACTOR = 0.0005
const SEGMENTS = 64
const TINT_CODE: Record<MapLayerTint, number> = { source: 0, white: 1, black: 2 }

export interface VrMapOverlay {
  /** A picture, or a real-time overlay stream's video (a VideoTexture keeps it current). */
  readonly image: HTMLImageElement | HTMLCanvasElement | HTMLVideoElement
  readonly tint: MapLayerTint
  readonly opacity?: number
  /**
   * A value-encoded stream's 256-entry RGBA palette, indexed by the raw
   * luma code, and the map's rectangle in the frame in image space (rows
   * from the top), as earthTileLayer takes them. Absent for a picture.
   */
  readonly lut?: Uint8Array
  readonly crop?: { u0: number; v0: number; us: number; vs: number }
}

export interface VrMapOverlaysHandle {
  /** Replace the overlays, bottom first. An empty list removes them all. */
  set(overlays: readonly VrMapOverlay[]): void
  dispose(): void
}

export function createVrMapOverlays(
  THREE_: typeof THREE,
  globe: THREE.Mesh,
  globeRadius: number,
): VrMapOverlaysHandle {
  let shells: Array<{
    mesh: THREE.Mesh
    texture: THREE.Texture
    lutTexture: THREE.DataTexture | null
    material: THREE.ShaderMaterial
    geometry: THREE.SphereGeometry
  }> = []
  let current: readonly VrMapOverlay[] = []

  function clear(): void {
    for (const s of shells) {
      globe.remove(s.mesh)
      s.texture.dispose()
      s.lutTexture?.dispose()
      s.material.dispose()
      s.geometry.dispose()
    }
    shells = []
  }

  function shell(overlay: VrMapOverlay, index: number) {
    const texture = overlay.image instanceof HTMLVideoElement
      ? new THREE_.VideoTexture(overlay.image)
      : new THREE_.Texture(overlay.image)
    let lutTexture: THREE.DataTexture | null = null
    if (overlay.lut) {
      // Codes, not colours: no colour-space decode and no filtering that
      // would average neighbouring codes into a value nobody measured.
      texture.colorSpace = THREE_.NoColorSpace
      texture.minFilter = THREE_.NearestFilter
      texture.magFilter = THREE_.NearestFilter
      texture.generateMipmaps = false
      lutTexture = new THREE_.DataTexture(overlay.lut, 256, 1, THREE_.RGBAFormat)
      lutTexture.colorSpace = THREE_.SRGBColorSpace
      lutTexture.minFilter = THREE_.NearestFilter
      lutTexture.magFilter = THREE_.NearestFilter
      lutTexture.needsUpdate = true
    } else {
      texture.colorSpace = THREE_.SRGBColorSpace
      texture.anisotropy = 4
    }
    texture.needsUpdate = true
    // THREE flips Y on upload, so v counts from the bottom of the frame.
    const crop = overlay.crop
    const region = crop
      ? new THREE_.Vector4(crop.u0, 1 - (crop.v0 + crop.vs), crop.us, crop.vs)
      : new THREE_.Vector4(0, 0, 1, 1)
    const material = new THREE_.ShaderMaterial({
      uniforms: {
        uMap: { value: texture },
        uTint: { value: TINT_CODE[overlay.tint] },
        uOpacity: { value: overlay.opacity ?? 1 },
        uEncoded: { value: lutTexture !== null },
        uLut: { value: lutTexture },
        uRegion: { value: region },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        precision highp float;
        uniform sampler2D uMap;
        uniform int uTint;
        uniform float uOpacity;
        uniform bool uEncoded;
        uniform sampler2D uLut;
        uniform vec4 uRegion;
        varying vec2 vUv;
        void main() {
          vec2 uv = uRegion.xy + vUv * uRegion.zw;
          vec4 tex = uEncoded
            ? texture2D(uLut, vec2((floor(texture2D(uMap, uv).r * 255.0 + 0.5) + 0.5) / 256.0, 0.5))
            : texture2D(uMap, uv);
          float a = tex.a * uOpacity;
          if (a < 0.01) discard;
          vec3 rgb = uTint == 1 ? vec3(1.0) : (uTint == 2 ? vec3(0.0) : tex.rgb);
          gl_FragColor = vec4(rgb * a, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE_.CustomBlending,
      blendEquation: THREE_.AddEquation,
      blendSrc: THREE_.OneFactor,
      blendDst: THREE_.OneMinusSrcAlphaFactor,
      premultipliedAlpha: true,
      side: THREE_.DoubleSide,
    })
    const geometry = new THREE_.SphereGeometry(
      globeRadius * (BASE_RADIUS_FACTOR + index * STEP_RADIUS_FACTOR),
      SEGMENTS,
      SEGMENTS,
    )
    const mesh = new THREE_.Mesh(geometry, material)
    // After the globe and the borders shell, in stack order.
    mesh.renderOrder = 2 + index
    globe.add(mesh)
    return { mesh, texture, lutTexture, material, geometry }
  }

  return {
    set(overlays) {
      const same = overlays.length === current.length &&
        overlays.every((o, i) => {
          const c = current[i]!
          return o.image === c.image && o.tint === c.tint && (o.opacity ?? 1) === (c.opacity ?? 1) && o.lut === c.lut
        })
      if (same) return
      current = overlays
      clear()
      shells = overlays.map(shell)
    },
    dispose() {
      clear()
      current = []
    },
  }
}
