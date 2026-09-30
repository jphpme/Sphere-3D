// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project
/**
 * AYNI — the panel a geo-media dataset (radio stations, wildlife cams)
 * shows on the browser globe: what is on, where it comes from, whether
 * it is live, and the picture when there is one. It sits where the
 * playback bar sits for a video dataset, which these datasets don't
 * have.
 */
import { plural, t } from '../i18n'
import type { GeoMediaMarker } from '../services/geoMedia'
import type { GeoMediaPlayback } from '../services/geoMediaPlayer'

export interface GeoMediaPanelOptions {
  markers: readonly GeoMediaMarker[]
  /** The player's elements; the panel shows the one the marker uses. */
  video: HTMLVideoElement
  image: HTMLImageElement
  onPauseResume(): void
  onToggleMute(): void
  onStop(): void
}

export interface GeoMediaPanelHandle {
  update(playback: GeoMediaPlayback, muted: boolean): void
  dispose(): void
}

function button(className: string, glyph: string): HTMLButtonElement {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = `transport-btn ${className}`
  el.textContent = glyph
  return el
}

function label(el: HTMLElement, text: string): void {
  el.title = text
  el.setAttribute('aria-label', text)
}

/** "Alfeld, Germany": the place, then the country, without saying either twice. */
export function placeLine(marker: GeoMediaMarker): string {
  const parts = [marker.location, marker.country].filter((p): p is string => !!p)
  return parts.filter((p, i) => parts.findIndex(q => q.toLowerCase() === p.toLowerCase()) === i).join(', ')
}

function statusText(playback: GeoMediaPlayback): string {
  const marker = playback.marker
  switch (playback.phase) {
    case 'connecting': return t('geoMedia.status.connecting')
    case 'paused': return t('geoMedia.status.paused')
    case 'unavailable': return t('geoMedia.status.unavailable')
    case 'playing': {
      // A snapshot cam is not a live feed, and the panel must not say it is.
      if (marker?.kind !== 'image') return t('geoMedia.status.live')
      const seconds = Math.round(marker.refreshSeconds ?? 0)
      return seconds >= 90
        ? t('geoMedia.status.still.minutes', { count: Math.round(seconds / 60) })
        : t('geoMedia.status.still.seconds', { count: seconds })
    }
    default: return ''
  }
}

export function createGeoMediaPanel(options: GeoMediaPanelOptions): GeoMediaPanelHandle {
  const { markers, video, image } = options
  const onlyAudio = markers.every(m => m.kind === 'audio')

  const panel = document.createElement('section')
  panel.id = 'geo-media-panel'
  panel.className = 'ui-panel geo-media-panel'
  panel.setAttribute('aria-label', t('geoMedia.panel.aria'))

  const screen = document.createElement('div')
  screen.className = 'geo-media-screen'
  screen.hidden = true
  video.classList.add('geo-media-picture')
  image.classList.add('geo-media-picture')
  screen.append(video, image)

  const row = document.createElement('div')
  row.className = 'geo-media-row'
  const text = document.createElement('div')
  text.className = 'geo-media-text'
  const status = document.createElement('div')
  status.className = 'geo-media-status'
  status.setAttribute('role', 'status')
  const light = document.createElement('span')
  light.className = 'geo-media-light'
  light.setAttribute('aria-hidden', 'true')
  const statusLabel = document.createElement('span')
  status.append(light, statusLabel)
  const title = document.createElement('div')
  title.className = 'geo-media-title'
  const place = document.createElement('div')
  place.className = 'geo-media-place'
  const credit = document.createElement('div')
  credit.className = 'geo-media-credit'
  text.append(status, title, place, credit)

  const actions = document.createElement('div')
  actions.className = 'geo-media-actions'
  const toggle = button('geo-media-toggle', '⏸︎')
  const mute = button('geo-media-mute', '\u{1F50A}︎')
  const stop = button('geo-media-stop', '✕')
  label(stop, t('geoMedia.action.stop'))
  toggle.addEventListener('click', () => options.onPauseResume())
  mute.addEventListener('click', () => options.onToggleMute())
  stop.addEventListener('click', () => options.onStop())
  actions.append(toggle, mute, stop)

  row.append(text, actions)
  panel.append(screen, row)
  ;(document.getElementById('ui') ?? document.body).appendChild(panel)

  const update = (playback: GeoMediaPlayback, muted: boolean): void => {
    const marker = playback.marker
    panel.dataset.phase = playback.phase
    if (!marker) {
      screen.hidden = true
      status.hidden = true
      actions.hidden = true
      credit.hidden = true
      title.textContent = t(onlyAudio ? 'geoMedia.hint.listen' : 'geoMedia.hint.watch')
      place.textContent = onlyAudio
        ? plural(markers.length, { one: 'geoMedia.count.stations.one', other: 'geoMedia.count.stations.other' })
        : plural(markers.length, { one: 'geoMedia.count.cams.one', other: 'geoMedia.count.cams.other' })
      return
    }
    // The picture area opens with the cam, so the panel does not jump when the first frame lands.
    screen.hidden = marker.kind === 'audio' || playback.phase === 'unavailable'
    video.hidden = marker.kind !== 'video'
    image.hidden = marker.kind !== 'image'
    status.hidden = false
    statusLabel.textContent = statusText(playback)
    title.textContent = marker.title
    const where = placeLine(marker)
    place.textContent = [where, marker.subjects].filter(Boolean).join(' · ')
    place.hidden = !place.textContent

    credit.replaceChildren()
    const creditName = marker.credit ?? (marker.sourcePage ? new URL(marker.sourcePage).hostname : '')
    credit.hidden = !creditName
    if (creditName) {
      credit.append(`${t('geoMedia.credit.label')} `)
      if (marker.sourcePage) {
        const link = document.createElement('a')
        link.href = marker.sourcePage
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
        link.textContent = creditName
        credit.append(link)
      } else {
        credit.append(creditName)
      }
    }

    actions.hidden = false
    const held = playback.phase === 'paused' || playback.phase === 'unavailable'
    toggle.textContent = held ? '▶︎' : '⏸︎'
    label(toggle, held
      ? t(playback.phase === 'unavailable' ? 'geoMedia.action.retry' : 'geoMedia.action.resume')
      : t('geoMedia.action.pause'))
    // A still picture has no sound to turn off.
    mute.hidden = marker.kind === 'image'
    mute.textContent = muted ? '\u{1F507}︎' : '\u{1F50A}︎'
    mute.setAttribute('aria-pressed', muted ? 'true' : 'false')
    label(mute, muted ? t('geoMedia.action.unmute') : t('geoMedia.action.mute'))
  }

  return {
    update,
    dispose() {
      panel.remove()
    },
  }
}
