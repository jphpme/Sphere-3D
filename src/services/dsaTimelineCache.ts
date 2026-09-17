// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Fetch and remember the `.dsa` time axes a session needs.
 *
 * The caller is a render loop — `vrSession` asks for a timeline once per
 * XR frame — so this is shaped for that: `prefetch(url)` is
 * fire-and-forget and idempotent, `get(url)` is a synchronous map read,
 * and neither can throw. The parse itself lives in
 * {@link file://./dsaTimeline.ts dsaTimeline.ts}; this module only
 * decides *when* bytes are fetched and *what* is remembered.
 *
 * Three rules, each of which would be a bug the other way round:
 *
 *   - **One fetch per URL, success or failure.** The index is a
 *     publisher's output and one row's `.dsa` 404s today. Retrying a
 *     miss every frame would put a failing request on the wire 90 times
 *     a second, so a failure is cached exactly as a success is.
 *   - **Concurrent callers share the request.** Two panels loading the
 *     same dataset, or a poll racing a prefetch, join one promise
 *     instead of starting a second fetch.
 *   - **A missing axis is not an error.** `get` returns null for
 *     "not arrived", "no time block", and "no such file" alike; the
 *     caller draws no track, which is the honest outcome for all three.
 *
 * `fetchImpl` is injected (the `MultiOutputHost` / `createEarth`
 * pattern) so the rules above are testable without a network.
 *
 * See {@link file://./../../docs/VR_PLAYBACK_TRACK_PLAN.md VR_PLAYBACK_TRACK_PLAN.md}.
 */

import { logger } from '../utils/logger'
import { parseDsaTimeline, type DsaTimeline } from './dsaTimeline'

export interface DsaTimelineCacheOptions {
  /**
   * Fetch implementation. `undefined` uses the global `fetch`; `null`
   * says there is none (a worker or SSR context) and makes every
   * `load` resolve to null without touching the network — which is also
   * how a test proves that path.
   */
  readonly fetchImpl?: typeof fetch | null
}

export interface DsaTimelineCache {
  /** The parsed axis, or null when it has not arrived or will never. */
  get(url: string): DsaTimeline | null
  /** True while a request for this URL is in flight. */
  isPending(url: string): boolean
  /** True once this URL has been tried — successfully or not. */
  isSettled(url: string): boolean
  /**
   * Start (or join) the fetch for a URL. Never rejects, never awaits,
   * never fetches twice. Safe to call from a per-frame poll.
   */
  prefetch(url: string): void
  /** Awaitable form of {@link prefetch}, for callers that want the answer. */
  load(url: string): Promise<DsaTimeline | null>
  /** Drop every cached axis. For a session teardown in tests. */
  clear(): void
}

export function createDsaTimelineCache(
  opts: DsaTimelineCacheOptions = {},
): DsaTimelineCache {
  // `undefined` means "use the global one"; `null` means "there is none".
  // `??` cannot express that — it folds both into the global fetch, which
  // is exactly the path a caller passes `null` to avoid.
  const fetchImpl =
    opts.fetchImpl === undefined
      ? typeof fetch !== 'undefined'
        ? fetch
        : null
      : opts.fetchImpl
  /** Settled outcomes, including the nulls. */
  const settled = new Map<string, DsaTimeline | null>()
  /** In-flight requests, so concurrent callers share one. */
  const pending = new Map<string, Promise<DsaTimeline | null>>()

  async function fetchTimeline(url: string): Promise<DsaTimeline | null> {
    if (!fetchImpl) return null
    try {
      const res = await fetchImpl(url, { headers: { Accept: 'application/json' } })
      if (!res.ok) {
        // Debug, not warn: a row whose annotation has not been published
        // yet is a normal state of a live catalog, not a fault.
        logger.debug(`[dsaTimeline] ${url} -> HTTP ${res.status}`)
        return null
      }
      return parseDsaTimeline(await res.json())
    } catch (err) {
      logger.debug(`[dsaTimeline] ${url} failed:`, err)
      return null
    }
  }

  function load(url: string): Promise<DsaTimeline | null> {
    if (!url) return Promise.resolve(null)
    if (settled.has(url)) return Promise.resolve(settled.get(url) ?? null)
    const inFlight = pending.get(url)
    if (inFlight) return inFlight
    const request = fetchTimeline(url).then(timeline => {
      settled.set(url, timeline)
      pending.delete(url)
      return timeline
    })
    pending.set(url, request)
    return request
  }

  return {
    get(url) {
      return settled.get(url) ?? null
    },
    isPending(url) {
      return pending.has(url)
    },
    isSettled(url) {
      return settled.has(url)
    },
    prefetch(url) {
      void load(url)
    },
    load,
    clear() {
      settled.clear()
      pending.clear()
    },
  }
}
