// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GeoMediaMarker } from './geoMedia'
import { GeoMediaPlayer, type GeoMediaPlayback } from './geoMediaPlayer'

vi.mock('hls.js', () => ({ default: { isSupported: () => false, Events: { ERROR: 'hlsError' } } }))

const station: GeoMediaMarker = {
  id: 'st', title: 'Station', kind: 'audio', latitude: 0, longitude: 0, streamUrl: 'https://radio.example/live.mp3', online: true,
}
const videoCam: GeoMediaMarker = { ...station, id: 'vc', kind: 'video', streamUrl: 'https://cam.example/live.m3u8' }
const stillCam: GeoMediaMarker = { ...station, id: 'sc', kind: 'image', streamUrl: 'https://relay.example/snapshot', refreshSeconds: 30 }

function setup(fetchImpl?: typeof fetch) {
  const states: GeoMediaPlayback[] = []
  const player = new GeoMediaPlayer({ onChange: s => states.push(s), startTimeoutMs: 1000, ...(fetchImpl ? { fetchImpl } : {}) })
  // happy-dom's media elements do not play; the test drives their events.
  const playCalls: HTMLMediaElement[] = []
  for (const el of [player.audio, player.video]) {
    vi.spyOn(el, 'play').mockImplementation(async () => { playCalls.push(el) })
    vi.spyOn(el, 'pause').mockImplementation(() => {})
    vi.spyOn(el, 'load').mockImplementation(() => {})
  }
  const phases = () => states.map(s => `${s.marker?.id ?? '-'}:${s.phase}`)
  return { player, states, phases, playCalls }
}

describe('GeoMediaPlayer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:pic', revokeObjectURL: () => {} }))
  })
  afterEach(() => { vi.useRealTimers() })

  it('connects a station, then reports it playing when sound starts', () => {
    const { player, phases, playCalls } = setup()
    player.play(station)
    expect(player.audio.src).toBe(station.streamUrl)
    expect(playCalls).toEqual([player.audio])
    expect(phases()).toEqual(['st:connecting'])
    player.audio.dispatchEvent(new Event('playing'))
    expect(phases()).toEqual(['st:connecting', 'st:playing'])
  })

  it('gives up on a stream that produces nothing in time, and remembers it', () => {
    const { player, phases } = setup()
    player.play(station)
    vi.advanceTimersByTime(1000)
    expect(phases()).toEqual(['st:connecting', 'st:unavailable'])
    expect(player.isUnavailable('st')).toBe(true)
    expect(player.audio.hasAttribute('src')).toBe(false)
    // Trying again clears the mark until it fails again.
    player.play(station)
    expect(player.isUnavailable('st')).toBe(false)
  })

  it('takes the element error as the stream failing', () => {
    const { player, phases } = setup()
    player.play(station)
    Object.defineProperty(player.audio, 'error', { value: { code: 4 }, configurable: true })
    player.audio.dispatchEvent(new Event('error'))
    expect(phases().at(-1)).toBe('st:unavailable')
  })

  it('drops a station on pause and joins it afresh on resume', () => {
    const { player, phases, playCalls } = setup()
    player.play(station)
    player.audio.dispatchEvent(new Event('playing'))
    player.pause()
    expect(phases().at(-1)).toBe('st:paused')
    expect(player.audio.hasAttribute('src')).toBe(false)
    vi.advanceTimersByTime(5000)
    expect(phases().at(-1)).toBe('st:paused')
    player.resume()
    expect(phases().at(-1)).toBe('st:connecting')
    expect(playCalls).toHaveLength(2)
  })

  it('a newer play supersedes a start still under way', () => {
    const { player, phases } = setup()
    player.play(station)
    player.play({ ...station, id: 'st2' })
    vi.advanceTimersByTime(1000)
    expect(phases()).toEqual(['st:connecting', 'st2:connecting', 'st2:unavailable'])
    expect(player.isUnavailable('st')).toBe(false)
  })

  it('plays a video cam in the video element, muted with the audio', () => {
    const { player, playCalls } = setup()
    player.setMuted(true)
    player.play(videoCam)
    expect(playCalls).toEqual([player.video])
    expect(player.video.muted).toBe(true)
    expect(player.video.crossOrigin).toBe('anonymous')
    player.video.dispatchEvent(new Event('playing'))
    expect(player.playback.phase).toBe('playing')
    player.video.dispatchEvent(new Event('waiting'))
    expect(player.playback.phase).toBe('connecting')
    vi.advanceTimersByTime(1000)
    expect(player.playback.phase).toBe('unavailable')
  })

  it('shows a snapshot cam through the image and keeps the picture while paused', async () => {
    const fetchImpl = vi.fn(async () => new Response(new Blob(['x'], { type: 'image/jpeg' }), { status: 200 }))
    const { player, phases } = setup(fetchImpl as unknown as typeof fetch)
    player.play(stillCam)
    await vi.advanceTimersByTimeAsync(0)
    expect(phases()).toEqual(['sc:connecting', 'sc:playing'])
    expect(player.image.src).toBe('blob:pic')
    player.pause()
    expect(player.image.src).toBe('blob:pic')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    player.resume()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(player.playback.phase).toBe('playing')
    player.stop()
    expect(player.playback).toEqual({ marker: null, phase: 'idle' })
    expect(player.image.hasAttribute('src')).toBe(false)
  })

  it('reports a snapshot cam that cannot produce a picture', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 404 }))
    const { player, phases } = setup(fetchImpl as unknown as typeof fetch)
    player.play(stillCam)
    await vi.advanceTimersByTimeAsync(0)
    expect(phases()).toEqual(['sc:connecting', 'sc:unavailable'])
  })
})
