// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { sphereUvToLatLon } from './datasetProbe'
import type { GeoMediaMarker } from './geoMedia'
import { createVrGeoMedia, labelText, latLonToGlobeLocal, type VrGeoMediaState } from './vrGeoMedia'
import type { VrTourOverlayHandle } from './vrTourOverlay'

const marker = (id: string, latitude: number, longitude: number, extra: Partial<GeoMediaMarker> = {}): GeoMediaMarker => ({
  id, title: id, kind: 'audio', latitude, longitude, streamUrl: 'https://x', online: true, ...extra,
})

describe('latLonToGlobeLocal', () => {
  it('lands on the point of the globe mesh whose UV the raycast would report', () => {
    // THREE's sphere UV layout is what sphereUvToLatLon reads back from a hit.
    const geometry = new THREE.SphereGeometry(1, 72, 36)
    const position = geometry.getAttribute('position')
    const uv = geometry.getAttribute('uv')
    for (const [lat, lon] of [[0, 0], [45, 90], [-30, -120], [80, 179], [-60, 10]]) {
      const p = latLonToGlobeLocal(lat, lon, 1)
      // The nearest vertex of the mesh, and the place its UV names.
      let best = 0
      let bestD = Infinity
      for (let i = 0; i < position.count; i++) {
        const d = Math.hypot(position.getX(i) - p.x, position.getY(i) - p.y, position.getZ(i) - p.z)
        if (d < bestD) { bestD = d; best = i }
      }
      const there = sphereUvToLatLon({ x: uv.getX(best), y: uv.getY(best) })
      expect(there.lat).toBeCloseTo(lat, 0)
      // Longitude wraps at the antimeridian and is meaningless at the poles' vertices.
      expect(Math.abs(((there.lon - lon + 540) % 360) - 180)).toBeLessThan(3)
    }
  })

  it('puts the north pole up and the prime meridian on +x', () => {
    expect(latLonToGlobeLocal(90, 0, 2).y).toBeCloseTo(2)
    expect(latLonToGlobeLocal(0, 0, 2).x).toBeCloseTo(2)
  })
})

describe('labelText', () => {
  it('says status, name, place and animals, and the credit', () => {
    const m = marker('cam', 51.9, 9.8, {
      kind: 'image', title: 'Alfeld Storchcam', refreshSeconds: 60, location: 'Alfeld', country: 'Germany',
      subjects: 'white stork', credit: 'Stadt Alfeld',
    })
    expect(labelText({ marker: m, phase: 'playing' })).toBe('New picture every 60 s\nAlfeld Storchcam\nAlfeld, Germany · white stork\nSource: Stadt Alfeld')
    expect(labelText({ marker: m, phase: 'unavailable' }).split('\n')[0]).toBe('Not answering right now')
    expect(labelText({ marker: null, phase: 'idle' })).toBe('')
  })
})

function overlayStub() {
  return {
    showText: vi.fn(), showImage: vi.fn(), showVideo: vi.fn(), hideOverlay: vi.fn(),
  } as unknown as VrTourOverlayHandle & { showText: ReturnType<typeof vi.fn>; showImage: ReturnType<typeof vi.fn>; showVideo: ReturnType<typeof vi.fn>; hideOverlay: ReturnType<typeof vi.fn> }
}

function state(markers: readonly GeoMediaMarker[], playback: VrGeoMediaState['playback'], pictureVersion = 0): VrGeoMediaState {
  return {
    markers, playback, isUnavailable: () => false,
    video: document.createElement('video'), image: document.createElement('img'), pictureVersion,
  }
}

describe('createVrGeoMedia', () => {
  it('puts one dot per marker on the globe and takes them off again', () => {
    const globe = new THREE.Mesh(new THREE.SphereGeometry(0.5))
    const overlay = overlayStub()
    const geo = createVrGeoMedia(THREE, globe, 0.5, overlay)
    const markers = [marker('a', 0, 0), marker('b', 10, 10)]
    geo.set(state(markers, { marker: null, phase: 'idle' }))
    const dots = globe.children[0] as THREE.InstancedMesh
    expect(dots.count).toBe(2)
    expect(overlay.showText).not.toHaveBeenCalled()
    geo.set(null)
    expect(globe.children).toHaveLength(0)
  })

  it('colours the playing dot and shows its label, the video panel for a cam', () => {
    const globe = new THREE.Mesh(new THREE.SphereGeometry(0.5))
    const overlay = overlayStub()
    const geo = createVrGeoMedia(THREE, globe, 0.5, overlay)
    const markers = [marker('a', 0, 0), marker('cam', 10, 10, { kind: 'video', title: 'Nest' })]
    geo.set(state(markers, { marker: markers[1], phase: 'playing' }))
    const dots = globe.children[0] as THREE.InstancedMesh
    const c = new THREE.Color()
    dots.getColorAt(0, c)
    expect(c.getHex()).toBe(0x22c55e)
    dots.getColorAt(1, c)
    expect(c.getHex()).toBe(0xfacc15)
    expect(overlay.showVideo).toHaveBeenCalledTimes(1)
    expect(overlay.showText).toHaveBeenCalledWith(expect.objectContaining({ caption: 'Live\nNest' }))
    // The same state again is nothing new; a stop takes the panel down.
    geo.set(state(markers, { marker: markers[1], phase: 'playing' }))
    expect(overlay.showText).toHaveBeenCalledTimes(1)
    geo.set(state(markers, { marker: null, phase: 'idle' }))
    expect(overlay.hideOverlay).toHaveBeenCalledWith('geo-media-picture')
    expect(overlay.hideOverlay).toHaveBeenCalledWith('geo-media-label')
  })

  it('shows a station as a label only, and a cam that stopped answering without its picture', () => {
    const globe = new THREE.Mesh(new THREE.SphereGeometry(0.5))
    const overlay = overlayStub()
    const geo = createVrGeoMedia(THREE, globe, 0.5, overlay)
    const markers = [marker('a', 0, 0), marker('cam', 10, 10, { kind: 'video' })]
    geo.set(state(markers, { marker: markers[0], phase: 'playing' }))
    expect(overlay.showVideo).not.toHaveBeenCalled()
    expect(overlay.showText).toHaveBeenCalledTimes(1)
    geo.set(state(markers, { marker: markers[1], phase: 'unavailable' }))
    expect(overlay.showVideo).not.toHaveBeenCalled()
    expect(overlay.showText).toHaveBeenLastCalledWith(expect.objectContaining({ caption: 'Not answering right now\ncam' }))
  })
})
