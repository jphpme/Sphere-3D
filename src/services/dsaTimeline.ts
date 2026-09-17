// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The time axis a real-time or forecast stream declares beside itself.
 *
 * Every row of `public/assets/realtime-dash-datasets.json` names a
 * `.dsa` — a JSON dataset annotation sitting next to the `stream.mpd`
 * in R2, schema published at
 * `https://pachamama-studios.stream/schemas/dsa-v1.6.json`. Its time
 * block is the only place the app can learn what instant a frame on the
 * globe represents: the catalog row for these streams carries no
 * `startTime`/`endTime`, so the 2D date machinery in `utils/time.ts`
 * — which *infers* a display interval from catalog metadata — has
 * nothing to work from, while the DSA **declares** one.
 *
 * The mapping is arithmetic rather than inferred because the publisher
 * encodes one data frame per encoded video frame, and states both
 * cadences:
 *
 *     frame        = floor(videoTime × videoFrameRate)
 *     date(frame)  = timeRange.start + frame × timeCadenceSeconds
 *     duration     = timeTotalFrames / videoFrameRate
 *
 * Verified against live files across both kinds: 2880 frames at a 900 s
 * cadence encoded at 24 fps (two minutes of video, thirty days of
 * data), 834 at 14400 s, 96 at 54000 s, and a regional forecast at 31
 * frames / 3600 s encoded at 8 fps. The MPD agrees from the other side
 * — `mediaPresentationDuration="PT2M0.2S"` against `2880 / 24 = 120 s`,
 * and `availabilityStartTime` equal to `timeRange.start` — which is
 * what makes seeking by date safe.
 *
 * Everything here is plain arithmetic over numbers, so the contract is
 * testable without a headset, a network or a video element — the split
 * {@link file://./vrHeightControl.ts vrHeightControl.ts} already uses.
 * The fetch lives in `dsaTimelineCache.ts` and the drawing in
 * `vrTimelineTrack.ts`.
 *
 * See {@link file://./../../docs/VR_PLAYBACK_TRACK_PLAN.md VR_PLAYBACK_TRACK_PLAN.md}.
 */

/** How the DSA's provenance block describes one span of frames. */
export type DsaFrameAvailability = 'real' | 'filled' | 'missing' | 'estimated' | 'unknown'

/** One span of frames whose provenance is not simply "real". */
export interface DsaAvailabilitySpan {
  readonly startFrame: number
  readonly frameCount: number
  readonly availability: DsaFrameAvailability
  /**
   * For a `filled` span, the frame it repeats (`fillPolicy:
   * freeze_previous_frame`). Null for every other kind, and for a filled
   * span the file did not attribute.
   */
  readonly sourceFrame: number | null
}

/**
 * The provenance block, reduced to what a timeline draws.
 *
 * `spans` is **sparse**: the publisher lists the frames that are *not*
 * ordinary data, so a frame inside no span is `real` whenever the
 * status says the series is complete or partial, and `unknown` when
 * the file has no usable availability block at all. Treating the list
 * as a partition would paint every unlisted frame as suspect.
 */
export interface DsaAvailability {
  /** `complete` | `partial` | `unknown` | … as written; null when absent. */
  readonly status: string | null
  readonly spans: readonly DsaAvailabilitySpan[]
}

/**
 * One dataset's declared time axis.
 *
 * `declaredEndMs` is what the file wrote and `endMode` says how to read
 * it — `exclusive` (the end of the interval, so the last frame is one
 * cadence earlier) or `last_frame` (the timestamp of the final frame).
 * Neither is used for the maths, which goes through {@link frameCount}
 * and {@link cadenceMs} so a file that states both but disagrees with
 * its own end still maps frames correctly; they are kept so the axis can
 * be validated and shown honestly.
 */
export interface DsaTimeline {
  readonly startMs: number
  readonly declaredEndMs: number
  readonly endMode: 'exclusive' | 'last_frame'
  readonly frameCount: number
  readonly cadenceMs: number
  readonly videoFrameRate: number
  readonly availability: DsaAvailability
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * A finite number from a JSON field, or null.
 *
 * DSAs are written by a pipeline, not by hand, but a number has arrived
 * as a numeric string in this catalog before (`"900.0"`), and
 * `Number("900.0")` costs nothing next to a wrong axis.
 */
function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function parseIsoMs(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

const AVAILABILITY_KINDS: readonly DsaFrameAvailability[] = [
  'real',
  'filled',
  'missing',
  'estimated',
  'unknown',
]

function parseAvailability(raw: unknown): DsaAvailability {
  const record = asRecord(raw)
  if (!record) return { status: null, spans: [] }
  const status = typeof record.status === 'string' ? record.status : null
  const rawSpans = Array.isArray(record.ranges) ? record.ranges : []
  const spans: DsaAvailabilitySpan[] = []
  for (const entry of rawSpans) {
    const span = asRecord(entry)
    if (!span) continue
    const startFrame = num(span.startFrame)
    const frameCount = num(span.frameCount)
    if (startFrame === null || frameCount === null) continue
    if (startFrame < 0 || frameCount <= 0) continue
    const kind = typeof span.availability === 'string' ? span.availability : ''
    spans.push({
      startFrame: Math.floor(startFrame),
      frameCount: Math.floor(frameCount),
      availability: (AVAILABILITY_KINDS as readonly string[]).includes(kind)
        ? (kind as DsaFrameAvailability)
        : 'unknown',
      sourceFrame: num(span.sourceFrame) === null ? null : Math.floor(num(span.sourceFrame)!),
    })
  }
  // Sorted because {@link availabilityAtFrame} binary-searches, and the
  // publisher's own ordering is not part of the schema.
  spans.sort((a, b) => a.startFrame - b.startFrame)
  return { status, spans }
}

/**
 * Parse a `.dsa`'s time block, or null when it cannot carry a timeline.
 *
 * Deliberately strict, and it returns `null` rather than a partial
 * axis: a wrong date on a forecast is worse than no date, because the
 * user cannot tell the two apart. Each of the rejects has a reason:
 *
 *   - `timeEnabled === false` — the file says this is not a series.
 *   - an unparseable or absent `timeRange.start` — no origin.
 *   - no positive `timeTotalFrames` — nothing to index.
 *   - no positive cadence in either `timeCadenceSeconds` **or**
 *     derivable from the declared range — the axis has no scale. (A file
 *     that states only start/end/frames still parses: the cadence is
 *     `span / frameCount`, or `/ (frameCount - 1)` under
 *     `last_frame`.)
 *   - no positive `videoFrameRate` (nor the deprecated
 *     `timeFrameRate` alias) — without it the video playhead cannot be
 *     mapped to a frame at all, and the track would sit frozen while the
 *     globe advanced.
 */
export function parseDsaTimeline(raw: unknown): DsaTimeline | null {
  const root = asRecord(raw)
  if (!root) return null
  if (root.timeEnabled === false) return null

  const timeRange = asRecord(root.timeRange)
  const startMs = parseIsoMs(timeRange?.start)
  if (startMs === null) return null

  const endMode: DsaTimeline['endMode'] =
    root.timeRangeEndMode === 'last_frame' ? 'last_frame' : 'exclusive'
  const declaredEndMsRaw = parseIsoMs(timeRange?.end)

  const frameCountRaw = num(root.timeTotalFrames)
  const frameCount = frameCountRaw === null ? null : Math.floor(frameCountRaw)
  if (frameCount === null || frameCount <= 0) return null

  const cadenceSeconds = num(root.timeCadenceSeconds)
  let cadenceMs: number | null =
    cadenceSeconds !== null && cadenceSeconds > 0 ? cadenceSeconds * 1000 : null
  if (cadenceMs === null && declaredEndMsRaw !== null) {
    const spanMs = declaredEndMsRaw - startMs
    const divisor = endMode === 'last_frame' ? frameCount - 1 : frameCount
    if (spanMs > 0 && divisor > 0) cadenceMs = spanMs / divisor
  }
  if (cadenceMs === null || !(cadenceMs > 0)) return null

  const videoFrameRate = num(root.videoFrameRate) ?? num(root.timeFrameRate)
  if (videoFrameRate === null || videoFrameRate <= 0) return null

  const declaredEndMs = declaredEndMsRaw ?? startMs + frameCount * cadenceMs

  return {
    startMs,
    declaredEndMs,
    endMode,
    frameCount,
    cadenceMs,
    videoFrameRate,
    availability: parseAvailability(root.dataAvailability),
  }
}

// ---------------------------------------------------------------------------
// Frame ↔ date ↔ video time
// ---------------------------------------------------------------------------

function clampFrame(timeline: DsaTimeline, frame: number): number {
  if (!Number.isFinite(frame)) return 0
  return Math.max(0, Math.min(timeline.frameCount - 1, Math.floor(frame)))
}

/** Represented span of the whole axis, in ms — `frameCount × cadence`. */
export function timelineSpanMs(timeline: DsaTimeline): number {
  return timeline.frameCount * timeline.cadenceMs
}

/** Date of the first frame. Equal to `startMs`, named for reading. */
export function firstFrameDateMs(timeline: DsaTimeline): number {
  return timeline.startMs
}

/** Date of the final frame — one cadence before the axis's exclusive end. */
export function lastFrameDateMs(timeline: DsaTimeline): number {
  return timeline.startMs + (timeline.frameCount - 1) * timeline.cadenceMs
}

/** Seconds of video the whole axis occupies: `frameCount / videoFrameRate`. */
export function timelineDurationSeconds(timeline: DsaTimeline): number {
  return timeline.frameCount / timeline.videoFrameRate
}

/** Date of a data frame, clamped to the axis. */
export function dateAtFrameMs(timeline: DsaTimeline, frame: number): number {
  return timeline.startMs + clampFrame(timeline, frame) * timeline.cadenceMs
}

/** Nearest data frame to an instant, clamped to the axis. */
export function frameAtDateMs(timeline: DsaTimeline, epochMs: number): number {
  if (!Number.isFinite(epochMs)) return 0
  const raw = Math.round((epochMs - timeline.startMs) / timeline.cadenceMs)
  return clampFrame(timeline, raw)
}

/** The data frame the video playhead is inside. */
export function frameAtVideoTime(timeline: DsaTimeline, videoTimeSeconds: number): number {
  if (!Number.isFinite(videoTimeSeconds) || videoTimeSeconds <= 0) return 0
  return clampFrame(timeline, Math.floor(videoTimeSeconds * timeline.videoFrameRate))
}

/** The instant the video playhead currently represents. */
export function dateAtVideoTimeMs(timeline: DsaTimeline, videoTimeSeconds: number): number {
  return dateAtFrameMs(timeline, frameAtVideoTime(timeline, videoTimeSeconds))
}

/**
 * Video time that lands **inside** a data frame, not on its boundary.
 *
 * Half a frame past the frame's start: seeking to an exact boundary
 * leaves the decoder free to resolve to either side of the cut, and a
 * track that lands one frame off from the date it promised is the kind
 * of error nobody can see and everybody mistrusts.
 */
export function videoTimeForFrame(timeline: DsaTimeline, frame: number): number {
  return (clampFrame(timeline, frame) + 0.5) / timeline.videoFrameRate
}

/** Video time to seek to for an instant — the nearest frame's midpoint. */
export function videoTimeForDateMs(timeline: DsaTimeline, epochMs: number): number {
  return videoTimeForFrame(timeline, frameAtDateMs(timeline, epochMs))
}

/** Position of a frame on the axis, 0 (first) → 1 (exclusive end). */
export function progressAtFrame(timeline: DsaTimeline, frame: number): number {
  const span = timelineSpanMs(timeline)
  if (!(span > 0)) return 0
  // A frame owns the cell that *follows* its instant, so its midpoint is
  // half a cell along — which is where the playhead should sit.
  return (clampFrame(timeline, frame) + 0.5) / timeline.frameCount
}

/** Position of an instant on the axis, 0 → 1, unclamped at the ends. */
export function progressAtDateMs(timeline: DsaTimeline, epochMs: number): number {
  const span = timelineSpanMs(timeline)
  if (!(span > 0) || !Number.isFinite(epochMs)) return 0
  return (epochMs - timeline.startMs) / span
}

/** The frame under a 0 → 1 position on the axis — the inverse of {@link progressAtFrame}. */
export function frameAtProgress(timeline: DsaTimeline, progress: number): number {
  if (!Number.isFinite(progress)) return 0
  return clampFrame(timeline, Math.floor(progress * timeline.frameCount))
}

/**
 * Provenance of a frame: the declared span it falls in, or the block's
 * status. See {@link DsaAvailability} for why an unlisted frame is not
 * "missing".
 */
export function availabilityAtFrame(
  timeline: DsaTimeline,
  frame: number,
): DsaFrameAvailability {
  const target = clampFrame(timeline, frame)
  const spans = timeline.availability.spans
  let lo = 0
  let hi = spans.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const span = spans[mid]!
    if (target < span.startFrame) hi = mid - 1
    else if (target >= span.startFrame + span.frameCount) lo = mid + 1
    else return span.availability
  }
  const status = timeline.availability.status
  return status === 'complete' || status === 'partial' ? 'real' : 'unknown'
}
