// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SnapshotCamPoller } from './geoMediaSnapshotPoller'

const picture = (type = 'image/jpeg') => new Blob(['x'], { type })

function answers(list: Array<Response | Error>) {
  const calls: number[] = []
  const fetchImpl = vi.fn(async () => {
    calls.push(Date.now())
    const next = list.shift()
    if (!next) throw new TypeError('no more answers')
    if (next instanceof Error) throw next
    return next
  })
  return { fetchImpl, calls }
}

const ok = (headers: Record<string, string> = {}, type?: string) => new Response(picture(type), { status: 200, headers })

describe('SnapshotCamPoller', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('hands over the first picture, then one every refresh interval', async () => {
    const { fetchImpl } = answers([ok(), ok(), ok()])
    const frames: Blob[] = []
    const poller = new SnapshotCamPoller({ url: 'https://cam', refreshSeconds: 30, onFrame: b => frames.push(b), onFailure: () => {}, fetchImpl })
    await poller.start()
    expect(frames).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(29_000)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(frames).toHaveLength(2)
    poller.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('comes back sooner for a picture the relay marked stale, a few times', async () => {
    const { fetchImpl } = answers([ok({ 'X-Snapshot-Stale': 'refreshing' }), ok({ 'X-Snapshot-Stale': 'refreshing' }), ok(), ok()])
    const poller = new SnapshotCamPoller({ url: 'https://cam', refreshSeconds: 60, onFrame: () => {}, onFailure: () => {}, fetchImpl })
    await poller.start()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    // That one was fresh: back to the full interval.
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fetchImpl).toHaveBeenCalledTimes(4)
    poller.stop()
  })

  it('rejects start() when the cam answers with an error or a non-image', async () => {
    const bad = new SnapshotCamPoller({ url: 'https://cam', refreshSeconds: 10, onFrame: () => {}, onFailure: () => {}, fetchImpl: answers([new Response('', { status: 503 })]).fetchImpl })
    await expect(bad.start()).rejects.toThrow('snapshot-http-503')
    const text = new SnapshotCamPoller({ url: 'https://cam', refreshSeconds: 10, onFrame: () => {}, onFailure: () => {}, fetchImpl: answers([ok({}, 'text/html')]).fetchImpl })
    await expect(text.start()).rejects.toThrow('snapshot-not-an-image:text/html')
  })

  it('tries a first fetch that dies on the network again', async () => {
    const { fetchImpl } = answers([new TypeError('Failed to fetch'), ok()])
    const frames: Blob[] = []
    const poller = new SnapshotCamPoller({ url: 'https://cam', refreshSeconds: 10, onFrame: b => frames.push(b), onFailure: () => {}, fetchImpl, startRetryMs: 100 })
    const started = poller.start()
    await vi.advanceTimersByTimeAsync(100)
    await started
    expect(frames).toHaveLength(1)
    poller.stop()
  })

  it('reports a cam that stops answering, after tolerating a dropped picture', async () => {
    const { fetchImpl } = answers([ok(), new TypeError('drop'), ok(), new TypeError('drop'), new TypeError('drop')])
    const failures: string[] = []
    const poller = new SnapshotCamPoller({ url: 'https://cam', refreshSeconds: 10, onFrame: () => {}, onFailure: r => failures.push(r), fetchImpl, maxConsecutiveFailures: 2 })
    await poller.start()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(failures).toEqual([])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(failures).toEqual([])
    await vi.advanceTimersByTimeAsync(20_000)
    expect(failures).toEqual(['drop'])
    expect(poller.isRunning()).toBe(false)
  })

  it('pauses and resumes', async () => {
    const { fetchImpl } = answers([ok(), ok(), ok()])
    const poller = new SnapshotCamPoller({ url: 'https://cam', refreshSeconds: 10, onFrame: () => {}, onFailure: () => {}, fetchImpl })
    await poller.start()
    poller.pause()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    poller.resume()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    poller.stop()
  })
})
