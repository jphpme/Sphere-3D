// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RoomClientOptions, RoomStatus } from './roomClient'
import type { RoomLayers, RoomState, RoomView } from './roomProtocol'
import { followPlayback, leadTime, shouldSend, startRoomSync, viewsDiffer, type RoomSyncHost } from './roomSync'

const playing = { paused: false, time: 10, duration: 120, rate: 1 }
const state = (over: Partial<RoomState> = {}): RoomState => ({
  datasetId: 'DS_1',
  playback: playing,
  globe: { q: [0, 0, 0, 1], scale: 1, aligned: true },
  view: null,
  layers: null,
  ...over,
})

describe('leadTime', () => {
  it('runs on while playing and stands still while paused', () => {
    expect(leadTime(playing, 2)).toBe(12)
    expect(leadTime({ ...playing, rate: 2 }, 2)).toBe(14)
    expect(leadTime({ ...playing, paused: true }, 2)).toBe(10)
  })

  it('rests at the end instead of wrapping', () => {
    expect(leadTime({ ...playing, time: 119 }, 5)).toBe(120)
  })
})

describe('followPlayback', () => {
  const local = { paused: false, time: 12, duration: 120, rate: 1 }

  it('leaves a follower alone when it is in step', () => {
    expect(followPlayback(playing, 2, local)).toEqual({ toggle: false, seekTo: null, rate: null })
    expect(followPlayback(playing, 2, { ...local, time: 12.4 }).seekTo).toBeNull()
  })

  it('seeks one that is clearly out of step', () => {
    expect(followPlayback(playing, 2, { ...local, time: 20 }).seekTo).toBe(12)
  })

  it('holds a paused lead’s frame closely', () => {
    const paused = { ...playing, paused: true }
    const fix = followPlayback(paused, 2, { ...local, time: 10.3 })
    expect(fix.toggle).toBe(true)
    expect(fix.seekTo).toBe(10)
  })

  it('compares positions as fractions when the two videos differ in length', () => {
    // The lead is a quarter of the way in; so should a follower be whose rendition is 2 s longer.
    const fix = followPlayback({ ...playing, time: 30 }, 0, { ...local, time: 0, duration: 122 })
    expect(fix.seekTo).toBeCloseTo(30.5, 6)
  })

  it('takes the lead’s rate', () => {
    expect(followPlayback({ ...playing, rate: 0.5 }, 0, { ...local, time: 10 }).rate).toBe(0.5)
  })
})

describe('shouldSend', () => {
  it('speaks first, and at least once a second', () => {
    expect(shouldSend(null, state(), Infinity)).toBe(true)
    expect(shouldSend(state(), state({ playback: { ...playing, time: 11 } }), 1000)).toBe(true)
  })

  it('says nothing about a video that is simply playing', () => {
    expect(shouldSend(state(), state({ playback: { ...playing, time: 10.3 } }), 300)).toBe(false)
  })

  it('reports a seek, a pause, a new dataset', () => {
    expect(shouldSend(state(), state({ playback: { ...playing, time: 60 } }), 300)).toBe(true)
    expect(shouldSend(state(), state({ playback: { ...playing, paused: true } }), 300)).toBe(true)
    expect(shouldSend(state(), state({ datasetId: 'DS_2' }), 300)).toBe(true)
  })

  it('reports the sphere turning or growing, not a still one', () => {
    const turned = Math.sin(0.01)
    expect(shouldSend(state(), state({ globe: { q: [0, turned, 0, Math.cos(0.01)], scale: 1, aligned: true } }), 100)).toBe(true)
    expect(shouldSend(state(), state({ globe: { q: [0, 0, 0, 1], scale: 1.05, aligned: true } }), 100)).toBe(true)
    expect(shouldSend(state(), state(), 100)).toBe(false)
    expect(shouldSend(state(), state({ globe: null }), 100)).toBe(true)
  })
})

describe('viewsDiffer', () => {
  const view = { lat: 10, lon: 20, zoom: 2, bearing: 0, pitch: 0 }

  it('ignores jitter and sees a real move', () => {
    expect(viewsDiffer(view, { ...view, lat: 10.01 })).toBe(false)
    expect(viewsDiffer(view, { ...view, lat: 11 })).toBe(true)
    expect(viewsDiffer(view, { ...view, zoom: 2.5 })).toBe(true)
    expect(viewsDiffer(view, { ...view, bearing: 5 })).toBe(true)
  })

  it('is finer close in', () => {
    const near = { ...view, zoom: 12 }
    expect(viewsDiffer(near, { ...near, lat: 10.01 })).toBe(true)
  })

  it('takes longitude the short way round', () => {
    expect(viewsDiffer({ ...view, lon: 179.999 }, { ...view, lon: -179.999 })).toBe(false)
  })
})

describe('shouldSend, for the camera and the layers', () => {
  const view = { lat: 10, lon: 20, zoom: 2, bearing: 0, pitch: 0 }
  const layers: RoomLayers = { basemapId: null, overlays: [], rt: null }

  it('reports a camera move and a layer change, not a still globe', () => {
    expect(shouldSend(state({ view, layers }), state({ view, layers }), 100)).toBe(false)
    expect(shouldSend(state({ view, layers }), state({ view: { ...view, lon: 40 }, layers }), 100)).toBe(true)
    expect(shouldSend(state({ view, layers }), state({ view, layers: { ...layers, rt: 'DS_RT' } }), 100)).toBe(true)
    expect(shouldSend(state({ view, layers }), state({ view, layers: { ...layers, overlays: [{ id: 'b', tint: 'white' }] } }), 100)).toBe(true)
  })
})

describe('startRoomSync', () => {
  let now = 0
  let client: RoomClientOptions
  let sent: RoomState[]
  let video: { currentTime: number; duration: number; playbackRate: number; readyState: number; seeking: boolean }
  let host: RoomSyncHost & {
    datasetId: string | null
    playingNow: boolean
    loads: string[]
    followed: unknown[]
    view: RoomView | null
    views: RoomView[]
    layers: RoomLayers[]
  }

  const status = (role: RoomStatus['role'], count = 2): RoomStatus => ({ code: 'ROOM42', connected: true, role, count })

  beforeEach(() => {
    vi.useFakeTimers()
    now = 0
    sent = []
    video = { currentTime: 10, duration: 120, playbackRate: 1, readyState: 4, seeking: false }
    host = {
      datasetId: 'DS_1',
      playingNow: true,
      loads: [],
      followed: [],
      getDatasetId: () => host.datasetId,
      loadDataset: (id) => { host.loads.push(id) },
      getVideo: () => video as unknown as HTMLVideoElement,
      isPlaying: () => host.playingNow,
      togglePlayPause: () => { host.playingNow = !host.playingNow },
      getGlobe: () => null,
      setFollowedGlobe: (g) => { host.followed.push(g) },
      view: null,
      views: [],
      layers: [],
      getView: () => host.view,
      setView: (v) => { host.views.push(v); host.view = v },
      getLayers: () => null,
      setLayers: (l) => { host.layers.push(l) },
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const start = () =>
    startRoomSync('ROOM42', host, {
      nowMs: () => now,
      connect: (_code, opts) => {
        client = opts
        return { status: () => status(null), send: (s) => { sent.push(s) }, close: () => {} }
      },
    })

  it('as the lead, describes its sphere at once and then only on change or heartbeat', () => {
    const sync = start()
    client.onStatus(status('lead'))
    vi.advanceTimersByTime(100)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toEqual({
      datasetId: 'DS_1',
      playback: { paused: false, time: 10, duration: 120, rate: 1 },
      globe: null,
      view: null,
      layers: null,
    })
    // Playing on, as predicted: silence until the heartbeat.
    for (let i = 0; i < 5; i++) { now += 100; video.currentTime += 0.1; vi.advanceTimersByTime(100) }
    expect(sent).toHaveLength(1)
    // A seek is news.
    now += 100; video.currentTime = 80; vi.advanceTimersByTime(100)
    expect(sent).toHaveLength(2)
    expect(sent[1].playback?.time).toBe(80)
    sync.stop()
  })

  it('as a follower, loads the lead’s dataset once and steers nothing until it is up', () => {
    const sync = start()
    client.onStatus(status('follower'))
    client.onState(state({ datasetId: 'DS_2' }))
    vi.advanceTimersByTime(1000)
    expect(host.loads).toEqual(['DS_2'])
    expect(video.currentTime).toBe(10)
    expect(sent).toHaveLength(0)
    sync.stop()
  })

  it('as a follower, pauses with the lead and takes its frame', () => {
    const sync = start()
    client.onStatus(status('follower'))
    client.onState(state({ playback: { paused: true, time: 60, duration: 120, rate: 1 } }))
    expect(host.playingNow).toBe(false)
    expect(video.currentTime).toBe(60)
    sync.stop()
  })

  it('hands the sphere to the lead’s pose while following, and back on becoming the lead', () => {
    const sync = start()
    client.onStatus(status('follower'))
    const globe = { q: [0, 0, 0, 1] as [number, number, number, number], scale: 1.5, aligned: true }
    client.onState(state({ globe }))
    expect(host.followed.at(-1)).toEqual(globe)
    client.onStatus(status('lead', 1))
    expect(host.followed.at(-1)).toBeNull()
    sync.stop()
  })

it('as a follower, moves its camera when the lead\u2019s moves, and not when it already matches', () => {
    const sync = start()
    client.onStatus(status('follower'))
    const view = { lat: -12, lon: -77, zoom: 4, bearing: 0, pitch: 0 }
    client.onState(state({ view }))
    expect(host.views).toEqual([view])
    client.onState(state({ view })) // the heartbeat: already there
    expect(host.views).toHaveLength(1)
    client.onState(state({ view: { ...view, lon: -60 } }))
    expect(host.views).toHaveLength(2)
    sync.stop()
  })

  it('as a follower, takes the lead\u2019s layers once the same dataset is up', () => {
    const sync = start()
    client.onStatus(status('follower'))
    const layers: RoomLayers = { basemapId: 'relief', overlays: [{ id: 'borders', tint: 'black' }], rt: null }
    client.onState(state({ datasetId: 'DS_2', layers }))
    expect(host.layers).toHaveLength(0) // still loading DS_2
    host.datasetId = 'DS_2'
    vi.advanceTimersByTime(250)
    expect(host.layers.at(-1)).toEqual(layers)
    sync.stop()
  })

  it('tells its listeners the status, now and on change', () => {
    const sync = start()
    const seen: (string | null)[] = []
    sync.onStatus((s) => seen.push(s.role))
    client.onStatus(status('follower'))
    expect(seen).toEqual([null, 'follower'])
    sync.stop()
  })
})
