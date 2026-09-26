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
  readonly image: HTMLImageElement | HTMLCanvasElement
  readonly tint: MapLayerTint
  readonly opacity?: number
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
  let shells: Array<{ mesh: THREE.Mesh; texture: THREE.Texture; material: THREE.ShaderMaterial; geometry: THREE.SphereGeometry }> = []
  let current: readonly VrMapOverlay[] = []

  function clear(): void {
    for (const s of shells) {
      globe.remove(s.mesh)
      s.texture.dispose()
      s.material.dispose()
      s.geometry.dispose()
    }
    shells = []
  }

  function shell(overlay: VrMapOverlay, index: number) {
    const texture = new THREE_.Texture(overlay.image)
    texture.colorSpace = THREE_.SRGBColorSpace
    texture.anisotropy = 4
    texture.needsUpdate = true
    const material = new THREE_.ShaderMaterial({
      uniforms: {
        uMap: { value: texture },
        uTint: { value: TINT_CODE[overlay.tint] },
        uOpacity: { value: overlay.opacity ?? 1 },
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
        varying vec2 vUv;
        void main() {
          vec4 tex = texture2D(uMap, vUv);
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
    return { mesh, texture, material, geometry }
  }

  return {
    set(overlays) {
      const same = overlays.length === current.length &&
        overlays.every((o, i) => o.image === current[i]!.image && o.tint === current[i]!.tint && (o.opacity ?? 1) === (current[i]!.opacity ?? 1))
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
