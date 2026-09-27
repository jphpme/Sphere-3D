// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { createVrMapOverlays } from './vrMapOverlays'

function globeWithOverlays() {
  const globe = new THREE.Mesh(new THREE.SphereGeometry(1))
  return { globe, overlays: createVrMapOverlays(THREE, globe, 1) }
}

function shellMaterial(globe: THREE.Mesh, index = 0): THREE.ShaderMaterial {
  return (globe.children[index] as THREE.Mesh).material as THREE.ShaderMaterial
}

describe('createVrMapOverlays', () => {
  it('draws a picture as published, over the whole frame', () => {
    const { globe, overlays } = globeWithOverlays()
    overlays.set([{ image: document.createElement('canvas'), tint: 'white' }])
    const m = shellMaterial(globe)
    expect(m.uniforms.uEncoded!.value).toBe(false)
    expect((m.uniforms.uRegion!.value as THREE.Vector4).toArray()).toEqual([0, 0, 1, 1])
  })

  it('decodes a value-encoded stream through its palette, inside its map rectangle', () => {
    const { globe, overlays } = globeWithOverlays()
    const lut = new Uint8Array(256 * 4)
    // Global Cloud Cover: the map is the top 1024 rows of a 1040-row frame.
    const crop = { u0: 0, v0: 0, us: 1, vs: 1024 / 1040 }
    overlays.set([{ image: document.createElement('video'), tint: 'source', lut, crop }])
    const m = shellMaterial(globe)
    expect(m.uniforms.uEncoded!.value).toBe(true)
    const lutTex = m.uniforms.uLut!.value as THREE.DataTexture
    expect(lutTex.image.data).toBe(lut)
    expect(lutTex.magFilter).toBe(THREE.NearestFilter)
    const map = m.uniforms.uMap!.value as THREE.Texture
    expect(map.magFilter).toBe(THREE.NearestFilter)
    expect(map.colorSpace).toBe(THREE.NoColorSpace)
    // THREE flips Y, so the calibration strip at the bottom is skipped
    // from v = 16/1040 up.
    const [u0, v0, us, vs] = (m.uniforms.uRegion!.value as THREE.Vector4).toArray()
    expect(u0).toBe(0)
    expect(v0).toBeCloseTo(16 / 1040, 10)
    expect(us).toBe(1)
    expect(vs).toBeCloseTo(1024 / 1040, 10)
  })

  it('rebuilds the shells when the palette changes', () => {
    const { globe, overlays } = globeWithOverlays()
    const video = document.createElement('video')
    overlays.set([{ image: video, tint: 'source', lut: new Uint8Array(1024) }])
    const first = globe.children[0]
    overlays.set([{ image: video, tint: 'source', lut: new Uint8Array(1024) }])
    expect(globe.children[0]).not.toBe(first)
    overlays.dispose()
    expect(globe.children).toHaveLength(0)
  })
})
