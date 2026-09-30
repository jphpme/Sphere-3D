// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project
/**
 * AYNI — a geo-media catalog's markers on the browser globe: one dot
 * per place, coloured by whether it can be played, is playing, or did
 * not answer. A click or tap near a dot picks it.
 */
import maplibregl from 'maplibre-gl'
import type { GeoJSONSource, Map as MaplibreMap, MapMouseEvent } from 'maplibre-gl'
import type { GeoMediaMarker } from './geoMedia'

export type GeoMediaMarkerStatus = 'available' | 'playing' | 'unavailable'

export interface GeoMediaLayerHandle {
  /** Recolour the dots: the marker that is on, and the ones that did not answer. */
  setStatus(activeId: string | null, isUnavailable: (marker: GeoMediaMarker) => boolean): void
  dispose(): void
}

const SOURCE_ID = 'geo-media-source'
const HALO_ID = 'geo-media-halo'
const DOT_ID = 'geo-media-dot'

/** A click this close to a dot plays it; a finger is given more room than a mouse. */
const CLICK_REACH_PX = 10
const TOUCH_REACH_PX = 18
/**
 * Dots this close are one place on the map: several cams of one zoo, or
 * two stations of one city seen from far out. Picking the place again
 * moves on to the next of them, so none is out of reach.
 */
const SAME_PLACE_PX = 3

// MapLibre paint cannot read CSS variables; these restate the tokens.
const COLOR_AVAILABLE = '#22c55e' // --color-accent
const COLOR_PLAYING = '#facc15' // --color-brand-end
const COLOR_UNAVAILABLE = '#8b93a1'

function featureCollection(
  markers: readonly GeoMediaMarker[],
  statusOf: (marker: GeoMediaMarker) => GeoMediaMarkerStatus,
): GeoJSON.FeatureCollection<GeoJSON.Point> {
  return {
    type: 'FeatureCollection',
    features: markers.map((marker, index) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [marker.longitude, marker.latitude] },
      properties: { index, title: marker.title, status: statusOf(marker) },
    })),
  }
}

export function addGeoMediaLayer(
  map: MaplibreMap,
  markers: readonly GeoMediaMarker[],
  onPick: (marker: GeoMediaMarker) => void,
): GeoMediaLayerHandle {
  let activeId: string | null = null
  const statusOf = (isUnavailable: (marker: GeoMediaMarker) => boolean) => (marker: GeoMediaMarker): GeoMediaMarkerStatus =>
    marker.id === activeId ? 'playing' : isUnavailable(marker) ? 'unavailable' : 'available'

  map.addSource(SOURCE_ID, { type: 'geojson', data: featureCollection(markers, statusOf(m => !m.online)) })
  // `zoom` may only feed a top-level interpolate, so the halo's extra
  // width goes into each stop rather than around the expression.
  const radius = (extra: number): maplibregl.ExpressionSpecification => [
    'interpolate', ['linear'], ['zoom'],
    0, ['case', ['==', ['get', 'status'], 'playing'], 6 + extra, 4 + extra],
    6, ['case', ['==', ['get', 'status'], 'playing'], 10 + extra, 7 + extra],
  ]
  // The one that is playing is drawn last, over its neighbours.
  const sortKey: maplibregl.ExpressionSpecification = ['match', ['get', 'status'], 'playing', 2, 'available', 1, 0]
  map.addLayer({
    id: HALO_ID,
    type: 'circle',
    source: SOURCE_ID,
    layout: { 'circle-sort-key': sortKey },
    paint: {
      'circle-radius': radius(2),
      'circle-color': 'rgba(13, 13, 18, 0.75)',
    },
  })
  map.addLayer({
    id: DOT_ID,
    type: 'circle',
    source: SOURCE_ID,
    layout: { 'circle-sort-key': sortKey },
    paint: {
      'circle-radius': radius(0),
      'circle-color': ['match', ['get', 'status'], 'playing', COLOR_PLAYING, 'unavailable', COLOR_UNAVAILABLE, COLOR_AVAILABLE],
      'circle-stroke-color': 'rgba(255, 255, 255, 0.9)',
      'circle-stroke-width': ['case', ['==', ['get', 'status'], 'playing'], 2, 0],
    },
  })

  /** The markers drawn within `reach` pixels of a point, nearest first. */
  const markersNear = (point: maplibregl.Point, reach: number): { marker: GeoMediaMarker; distance: number; x: number; y: number }[] => {
    const hits = map.queryRenderedFeatures(
      [[point.x - reach, point.y - reach], [point.x + reach, point.y + reach]],
      { layers: [DOT_ID] },
    )
    const seen = new Set<number>()
    const near: { marker: GeoMediaMarker; distance: number; x: number; y: number }[] = []
    for (const hit of hits) {
      const index = Number(hit.properties?.index)
      const marker = markers[index]
      if (!marker || seen.has(index)) continue
      seen.add(index)
      const at = map.project([marker.longitude, marker.latitude])
      const distance = Math.hypot(at.x - point.x, at.y - point.y)
      if (distance <= reach) near.push({ marker, distance, x: at.x, y: at.y })
    }
    return near.sort((a, b) => a.distance - b.distance)
  }

  const onClick = (event: MapMouseEvent): void => {
    const touch = (event.originalEvent as PointerEvent | undefined)?.pointerType === 'touch'
      || ('ontouchstart' in window && !window.matchMedia('(hover: hover)').matches)
    const near = markersNear(event.point, touch ? TOUCH_REACH_PX : CLICK_REACH_PX)
    if (!near.length) return
    // Markers at one place share a dot; picking it again moves on to the next of them.
    const stack = near
      .filter(n => Math.hypot(n.x - near[0].x, n.y - near[0].y) <= SAME_PLACE_PX)
      .map(n => n.marker)
    const active = stack.findIndex(m => m.id === activeId)
    onPick(stack[(active + 1) % stack.length])
  }
  map.on('click', onClick)

  const tipText = document.createElement('div')
  tipText.style.cssText = 'color:#fff;background:rgba(13,13,18,0.92);padding:6px 10px;border-radius:6px;font:13px/1.4 system-ui,sans-serif;white-space:nowrap;'
  const tip = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12, className: 'sos-popup geo-media-tip' })
    .setDOMContent(tipText)
  // A name under the pointer, so only where there is a pointer that
  // hovers: a tap also reports a mouse move, and the name it left up
  // would cover the neighbouring dots.
  const canHover = window.matchMedia?.('(hover: hover)').matches ?? true
  let tipIndex = -1
  const onMove = (event: MapMouseEvent): void => {
    const nearest = markersNear(event.point, CLICK_REACH_PX)[0]?.marker
    map.getCanvas().style.cursor = nearest ? 'pointer' : ''
    const index = nearest ? markers.indexOf(nearest) : -1
    if (index === tipIndex) return
    tipIndex = index
    if (!nearest) {
      tip.remove()
      return
    }
    tipText.textContent = nearest.title
    tip.setLngLat([nearest.longitude, nearest.latitude]).addTo(map)
  }
  const onOut = (): void => {
    tipIndex = -1
    tip.remove()
    map.getCanvas().style.cursor = ''
  }
  if (canHover) {
    map.on('mousemove', onMove)
    map.on('mouseout', onOut)
  }

  return {
    setStatus(nextActiveId, isUnavailable) {
      activeId = nextActiveId
      const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined
      source?.setData(featureCollection(markers, statusOf(isUnavailable)))
    },
    dispose() {
      map.off('click', onClick)
      map.off('mousemove', onMove)
      map.off('mouseout', onOut)
      onOut()
      try { map.removeLayer(DOT_ID) } catch { /* noop */ }
      try { map.removeLayer(HALO_ID) } catch { /* noop */ }
      try { map.removeSource(SOURCE_ID) } catch { /* noop */ }
    },
  }
}
