/**
 * Phase 3pt/E — debounced autosave for the tour-authoring dock.
 *
 * Lifecycle:
 *   1. Dock mounts with `tourId = 'new'` (fresh draft) or a
 *      server-issued ULID (re-opening an existing tour).
 *   2. First save while `tourId === 'new'` POSTs to
 *      /publish/tours/draft, captures the new ULID, then PUTs
 *      the current JSON. Subsequent saves go straight to PUT.
 *   3. Status flips through 'idle' → 'saving' → 'saved' (or
 *      'error'); the dock renders the latest value next to the
 *      title in the header.
 *
 * Debounce is intentionally simple: a fixed delay between the
 * last `requestSave` and the network call. The plan calls for
 * 30s autosave but tests + responsiveness benefit from a
 * shorter default; the prod value is set in the dock when it
 * constructs the manager.
 */

import { logger } from '../../utils/logger'
import type { TourFile } from '../../types'
import { createDraftTour, saveTourJson } from './api'

export type AutosaveStatus = 'idle' | 'saving' | 'saved' | 'error'

export interface AutosaveCallbacks {
  /** Notified whenever the status changes — the dock renders
   *  this next to the title. */
  onStatusChange: (status: AutosaveStatus, error?: string) => void
  /** Notified when the manager promotes a 'new' tour id to a
   *  server-issued ULID after the first POST /draft. The dock
   *  uses this to rewrite the URL so a reload reopens the
   *  same draft. */
  onTourIdResolved?: (newId: string) => void
}

export interface AutosaveOptions {
  /** Debounce window before a `requestSave` actually fires.
   *  Default 30 000 ms per the plan. Tests override to 0. */
  debounceMs?: number
  /** Override the API surface — tests inject stubs. */
  api?: {
    createDraftTour: typeof createDraftTour
    saveTourJson: typeof saveTourJson
  }
  /** Override `setTimeout`/`clearTimeout` for deterministic
   *  testing. Defaults to the globals. */
  scheduler?: {
    setTimeout: (cb: () => void, ms: number) => unknown
    clearTimeout: (handle: unknown) => void
  }
}

export interface AutosaveHandle {
  /** Current tour id. Mutates after the first save when the
   *  initial id was `'new'`. */
  getTourId: () => string
  /** Schedule a save with the current TourFile. Replaces any
   *  pending save in the debounce window. */
  requestSave: (tourFile: TourFile) => void
  /** Force an immediate save, bypassing the debounce. Returns
   *  when the save completes (or fails). Used for "save now"
   *  gestures like Discard-with-unsaved-changes flushes. */
  flush: () => Promise<void>
}

export function createAutosaveManager(
  initialTourId: string,
  callbacks: AutosaveCallbacks,
  options: AutosaveOptions = {},
): AutosaveHandle {
  const debounceMs = options.debounceMs ?? 30_000
  const api = options.api ?? { createDraftTour, saveTourJson }
  const sched = options.scheduler ?? {
    setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
    clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  }

  let tourId = initialTourId
  let pendingHandle: unknown = null
  let pendingPayload: TourFile | null = null
  let inFlight: Promise<void> | null = null
  let lastError = ''

  function setStatus(status: AutosaveStatus, error = ''): void {
    lastError = error
    callbacks.onStatusChange(status, error || undefined)
  }

  async function doSave(payload: TourFile): Promise<void> {
    setStatus('saving')
    try {
      // First save against a fresh draft — mint the row.
      if (tourId === 'new') {
        const created = await api.createDraftTour()
        if ('error' in created) {
          setStatus('error', created.error)
          return
        }
        tourId = created.tour.id
        callbacks.onTourIdResolved?.(tourId)
      }
      const result = await api.saveTourJson(tourId, payload)
      if ('error' in result) {
        setStatus('error', result.error)
        return
      }
      setStatus('saved')
    } catch (err) {
      // Network throw — surface as 'error' rather than crashing
      // the dock. The next requestSave retries.
      const message = err instanceof Error ? err.message : String(err)
      logger.warn('[tourAuthoring autosave]', message)
      setStatus('error', message)
    }
  }

  function scheduleFlush(): void {
    if (pendingHandle !== null) sched.clearTimeout(pendingHandle)
    pendingHandle = sched.setTimeout(() => {
      pendingHandle = null
      if (pendingPayload === null) return
      const payload = pendingPayload
      pendingPayload = null
      inFlight = doSave(payload).finally(() => {
        inFlight = null
      })
    }, debounceMs)
  }

  return {
    getTourId: () => tourId,
    requestSave: (tourFile: TourFile) => {
      pendingPayload = tourFile
      scheduleFlush()
    },
    flush: async () => {
      // Cancel any debounce and write immediately. If a save is
      // already in flight, wait for it first so we don't fire
      // two PUTs racing for the same row.
      if (pendingHandle !== null) {
        sched.clearTimeout(pendingHandle)
        pendingHandle = null
      }
      if (inFlight) await inFlight
      if (pendingPayload !== null) {
        const payload = pendingPayload
        pendingPayload = null
        await doSave(payload)
      }
    },
  }
}
