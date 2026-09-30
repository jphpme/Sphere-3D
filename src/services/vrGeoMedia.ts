// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project
/**
 * AYNI — a geo-media dataset (radio stations, wildlife cams) in the
 * headset: one dot per place on the immersive globe, and beside the
 * globe the panel of the one picked — its video or its still through
 * the tour overlay's panels, and a label with its name, place and
 * whether it is live. The host (main.ts) owns the player; this draws
 * what it reports, applied only when the state object changes.
 */

import type * as THREE from 'three'
import { t } from '../i18n'
import type { GeoMediaMarker } from './geoMedia'
import type { GeoMediaPlayback } from './geoMediaPlayer'
import type { VrTourOverlayHandle } from './vrTourOverlay'

/** What the host reports about the loaded geo-media dataset. A new object whenever any of it changes. */
export interface VrGeoMediaState {
  readonly markers: readonly GeoMediaMarker[]
  readonly playback: GeoMediaPlayback
  readonly isUnavailable: (marker: GeoMediaMarker) => boolean
  /** The player's elements, shown in the panel when the marker uses them. */
  readonly video: HTMLVideoElement
  readonly image: HTMLImageElement
  /** Bumped by every new still picture, so the panel repaints it. */
  readonly pictureVersion: number
}

export interface VrGeoMediaHandle {
  set(state: VrGeoMediaState | null): void
  dispose(): void
}

/** Dots stand this far off the globe surface, outside the overlay shells. */
const DOT_RADIUS_FACTOR = 1.004
/** A dot's radius, as a fraction of the globe's: 6 mm on the 0.5 m globe. */
const DOT_SIZE_FACTOR = 0.012
const DOT_SIZE_PLAYING_FACTOR = 0.018

const COLOR_AVAILABLE = 0x22c55e // --color-accent
const COLOR_PLAYING = 0xfacc15 // --color-brand-end
const COLOR_UNAVAILABLE = 0x8b93a1

const PICTURE_ID = 'geo-media-picture'
const LABEL_ID = 'geo-media-label'
/** Beside the globe, as the tour panels sit: the picture above, its label under it. */
const PICTURE_OFFSET = { x: 0.95, y: 0.12, z: 0.15 }
const LABEL_OFFSET = { x: 0.95, y: -0.3, z: 0.15 }
const PICTURE_SIZE = { width: 0.8, height: 0.45 }
const LABEL_SIZE = { width: 0.8, height: 0.22 }

/**
 * Where a place sits on the globe mesh, in its local frame: the inverse
 * of `sphereUvToLatLon` over THREE's sphere UV layout (u east from the
 * antimeridian, v north from the south pole).
 */
export function latLonToGlobeLocal(lat: number, lon: number, radius: number): { x: number; y: number; z: number } {
  const rad = Math.PI / 180
  const cosLat = Math.cos(lat * rad)
  return {
    x: radius * cosLat * Math.cos(lon * rad),
    y: radius * Math.sin(lat * rad),
    z: -radius * cosLat * Math.sin(lon * rad),
  }
}

function statusText(playback: GeoMediaPlayback): string {
  const marker = playback.marker
  switch (playback.phase) {
    case 'connecting': return t('geoMedia.status.connecting')
    case 'paused': return t('geoMedia.status.paused')
    case 'unavailable': return t('geoMedia.status.unavailable')
    case 'playing': {
      if (marker?.kind !== 'image') return t('geoMedia.status.live')
      const seconds = Math.round(marker.refreshSeconds ?? 0)
      return seconds >= 90
        ? t('geoMedia.status.still.minutes', { count: Math.round(seconds / 60) })
        : t('geoMedia.status.still.seconds', { count: seconds })
    }
    default: return ''
  }
}

/** The label's lines: status, name, place and animals, credit. */
export function labelText(playback: GeoMediaPlayback): string {
  const marker = playback.marker
  if (!marker) return ''
  const place = [marker.location, marker.country].filter((p): p is string => !!p)
  const where = place.filter((p, i) => place.findIndex(q => q.toLowerCase() === p.toLowerCase()) === i).join(', ')
  return [
    statusText(playback),
    marker.title,
    [where, marker.subjects].filter(Boolean).join(' · '),
    marker.credit ? `${t('geoMedia.credit.label')} ${marker.credit}` : '',
  ].filter(Boolean).join('\n')
}

export function createVrGeoMedia(
  THREE_: typeof THREE,
  globe: THREE.Mesh,
  globeRadius: number,
  tourOverlay: VrTourOverlayHandle,
): VrGeoMediaHandle {
  let dots: { mesh: THREE.InstancedMesh; geometry: THREE.BufferGeometry; material: THREE.Material; markers: readonly GeoMediaMarker[] } | null = null
  let applied: VrGeoMediaState | null = null
  let shownPicture: { markerId: string; kind: 'video' | 'image'; version: number } | null = null
  let shownLabel = ''
  const scratch = new THREE_.Object3D()
  const color = new THREE_.Color()

  function clearDots(): void {
    if (!dots) return
    globe.remove(dots.mesh)
    dots.geometry.dispose()
    dots.material.dispose()
    dots = null
  }

  function buildDots(markers: readonly GeoMediaMarker[]): void {
    clearDots()
    if (!markers.length) return
    const geometry = new THREE_.SphereGeometry(globeRadius * DOT_SIZE_FACTOR, 10, 8)
    const material = new THREE_.MeshBasicMaterial({ color: 0xffffff })
    const mesh = new THREE_.InstancedMesh(geometry, material, markers.length)
    markers.forEach((marker, i) => {
      const p = latLonToGlobeLocal(marker.latitude, marker.longitude, globeRadius * DOT_RADIUS_FACTOR)
      scratch.position.set(p.x, p.y, p.z)
      scratch.scale.setScalar(1)
      scratch.updateMatrix()
      mesh.setMatrixAt(i, scratch.matrix)
    })
    mesh.instanceMatrix.needsUpdate = true
    // Over the overlay shells (renderOrder 2+), never culled as one small sphere.
    mesh.renderOrder = 10
    mesh.frustumCulled = false
    globe.add(mesh)
    dots = { mesh, geometry, material, markers }
  }

  function colourDots(state: VrGeoMediaState): void {
    if (!dots) return
    const activeId = state.playback.marker && state.playback.phase !== 'unavailable' ? state.playback.marker.id : null
    dots.markers.forEach((marker, i) => {
      const playing = marker.id === activeId
      color.setHex(playing ? COLOR_PLAYING : !marker.online || state.isUnavailable(marker) ? COLOR_UNAVAILABLE : COLOR_AVAILABLE)
      dots!.mesh.setColorAt(i, color)
      const p = latLonToGlobeLocal(marker.latitude, marker.longitude, globeRadius * DOT_RADIUS_FACTOR)
      scratch.position.set(p.x, p.y, p.z)
      scratch.scale.setScalar(playing ? DOT_SIZE_PLAYING_FACTOR / DOT_SIZE_FACTOR : 1)
      scratch.updateMatrix()
      dots!.mesh.setMatrixAt(i, scratch.matrix)
    })
    dots.mesh.instanceMatrix.needsUpdate = true
    if (dots.mesh.instanceColor) dots.mesh.instanceColor.needsUpdate = true
  }

  function hidePanel(): void {
    if (shownPicture) tourOverlay.hideOverlay(PICTURE_ID)
    if (shownLabel) tourOverlay.hideOverlay(LABEL_ID)
    shownPicture = null
    shownLabel = ''
  }

  function showPanel(state: VrGeoMediaState): void {
    const { marker, phase } = state.playback
    if (!marker || phase === 'idle') {
      hidePanel()
      return
    }
    const showsPicture = marker.kind !== 'audio' && phase !== 'unavailable'
    if (!showsPicture) {
      if (shownPicture) tourOverlay.hideOverlay(PICTURE_ID)
      shownPicture = null
    } else if (marker.kind === 'video') {
      if (shownPicture?.markerId !== marker.id || shownPicture.kind !== 'video') {
        tourOverlay.showVideo({
          id: PICTURE_ID,
          video: state.video,
          anchor: { mode: 'world', offset: PICTURE_OFFSET },
          size: PICTURE_SIZE,
        })
        shownPicture = { markerId: marker.id, kind: 'video', version: 0 }
      }
    } else if (state.image.complete && state.image.naturalWidth > 0
      && (shownPicture?.markerId !== marker.id || shownPicture.kind !== 'image' || shownPicture.version !== state.pictureVersion)) {
      // Painted from the decoded element itself: a fresh fetch of a blob
      // address would flash the placeholder at every new picture.
      tourOverlay.showImage({
        imageID: PICTURE_ID,
        filename: state.image.src,
        image: state.image,
        anchor: { mode: 'world', offset: PICTURE_OFFSET },
        size: PICTURE_SIZE,
      })
      shownPicture = { markerId: marker.id, kind: 'image', version: state.pictureVersion }
    }
    const text = labelText(state.playback)
    if (text !== shownLabel) {
      tourOverlay.showText({
        rectID: LABEL_ID,
        caption: text,
        anchor: { mode: 'world', offset: showsPicture ? LABEL_OFFSET : PICTURE_OFFSET },
        size: LABEL_SIZE,
        showBorder: true,
      })
      shownLabel = text
    }
  }

  return {
    set(state) {
      if (state === applied) return
      if (!state) {
        applied = null
        clearDots()
        hidePanel()
        return
      }
      if (!dots || dots.markers !== state.markers) buildDots(state.markers)
      colourDots(state)
      showPanel(state)
      applied = state
    },
    dispose() {
      clearDots()
      hidePanel()
      applied = null
    },
  }
}
