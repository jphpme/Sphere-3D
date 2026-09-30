// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project
/**
 * AYNI — keeps a snapshot cam's picture fresh: fetches the still, hands
 * it over, then waits `refreshSeconds` before the next fetch. Fetches
 * never overlap, so a slow cam is polled more slowly rather than piling
 * requests up.
 */
import { snapshotRefreshSeconds } from './geoMedia'

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/**
 * The relay answers at once with a cam's last picture while it fetches
 * the next one, and marks that answer with this header. The next one is
 * worth coming back for soon, a few times, instead of after the whole
 * refresh interval.
 */
const STALE_HEADER = 'X-Snapshot-Stale'
const STALE_RETRY_MS = 5000
const MAX_STALE_RETRIES = 3

/**
 * A first fetch that dies on the network is tried again: a slow cam can
 * outlast a connection that some networks cut after five silent seconds,
 * and the relay finishes that fetch anyway, so the picture is there a
 * few seconds later.
 */
const START_RETRY_MS = 4000
const MAX_START_RETRIES = 2

export interface SnapshotCamPollerOptions {
  url: string
  refreshSeconds: number
  /** A new picture, as the bytes the cam sent. */
  onFrame(picture: Blob): void
  /** The cam stopped answering after the first picture. Not called for the first fetch, which rejects `start()`. */
  onFailure(reason: string): void
  fetchImpl?: FetchLike
  /** Consecutive failed fetches tolerated before `onFailure`; cams drop a picture now and then. */
  maxConsecutiveFailures?: number
  /** Wait between tries of the first fetch; tests shorten it. */
  startRetryMs?: number
}

export class SnapshotCamPoller {
  private readonly fetchImpl: FetchLike
  private readonly intervalMs: number
  private readonly maxConsecutiveFailures: number
  private timer: ReturnType<typeof setTimeout> | null = null
  private inFlight: AbortController | null = null
  private failures = 0
  private lastWasStale = false
  private staleRetries = 0
  private running = false
  private stopped = false

  constructor(private readonly options: SnapshotCamPollerOptions) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
    // Clamped here too: a 0 or NaN interval would poll flat out.
    this.intervalMs = snapshotRefreshSeconds(options.refreshSeconds) * 1000
    this.maxConsecutiveFailures = Math.max(1, options.maxConsecutiveFailures ?? 3)
  }

  /** Fetches the first picture; rejects when the cam can't produce one. */
  async start(): Promise<void> {
    this.running = true
    for (let attempt = 0; ; attempt++) {
      try {
        await this.fetchFrame()
        break
      } catch (error) {
        // fetch() reports a dropped connection as a TypeError; an HTTP error or a non-image is the cam's own answer.
        if (this.stopped || !(error instanceof TypeError) || attempt >= MAX_START_RETRIES) throw error
        await new Promise(resolve => setTimeout(resolve, this.options.startRetryMs ?? START_RETRY_MS))
        if (this.stopped) throw error
      }
    }
    this.schedule()
  }

  isRunning(): boolean {
    return this.running && !this.stopped
  }

  /** Keeps the last picture and stops fetching. */
  pause(): void {
    this.running = false
    this.clearTimer()
  }

  resume(): void {
    if (this.stopped || this.running) return
    this.running = true
    void this.tick()
  }

  stop(): void {
    this.stopped = true
    this.running = false
    this.clearTimer()
    this.inFlight?.abort()
    this.inFlight = null
  }

  private schedule(): void {
    this.clearTimer()
    if (!this.running || this.stopped) return
    this.timer = setTimeout(() => { void this.tick() }, this.nextDelayMs())
  }

  private nextDelayMs(): number {
    if (this.lastWasStale && this.staleRetries < MAX_STALE_RETRIES) {
      this.staleRetries += 1
      return Math.min(this.intervalMs, STALE_RETRY_MS)
    }
    if (!this.lastWasStale) this.staleRetries = 0
    return this.intervalMs
  }

  private async tick(): Promise<void> {
    this.timer = null
    if (!this.running || this.stopped) return
    try {
      await this.fetchFrame()
      this.failures = 0
    } catch (error) {
      if (this.stopped) return
      this.failures += 1
      if (this.failures >= this.maxConsecutiveFailures) {
        this.stop()
        this.options.onFailure(error instanceof Error ? error.message : String(error))
        return
      }
    }
    this.schedule()
  }

  private async fetchFrame(): Promise<void> {
    const controller = new AbortController()
    this.inFlight = controller
    try {
      const response = await this.fetchImpl(this.options.url, { cache: 'no-store', signal: controller.signal })
      if (!response.ok) throw new Error(`snapshot-http-${response.status}`)
      this.lastWasStale = Boolean(response.headers?.get(STALE_HEADER))
      const picture = await response.blob()
      if (!picture.type.startsWith('image/')) {
        throw new Error(`snapshot-not-an-image:${picture.type || 'unknown'}`)
      }
      if (this.stopped) return
      this.options.onFrame(picture)
    } finally {
      if (this.inFlight === controller) this.inFlight = null
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
