// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * What a `.dsa` says about its stream, for Orbit to answer from.
 *
 * {@link file://./dsaTimeline.ts dsaTimeline.ts} reads the time axis a
 * stream declares; this reads the rest of the same file — who made it,
 * when it was last updated, what kind of product it is, and how complete
 * the series is — and turns it, with the frame on screen, into a few
 * plain lines for the docent's prompt. Without it, "when was this last
 * updated?" or "is this frame real data?" had no answer but a guess:
 * the catalog row carries a title and a description, and the .dsa is the
 * only place the rest is written.
 *
 * Parsing is lenient where the timeline's is strict. A wrong date on a
 * forecast is worse than none, so the axis refuses a partial block; a
 * descriptor missing its creator is still worth describing, so each
 * field here is read on its own and simply left out when absent.
 */

import {
  availabilityAtFrame,
  dateAtFrameMs,
  firstFrameDateMs,
  lastFrameDateMs,
  type DsaTimeline,
} from './dsaTimeline'

export interface DsaCompleteness {
  /** `complete` | `partial` | … as written. */
  readonly status: string | null
  readonly expectedFrames: number | null
  readonly realFrames: number | null
  readonly filledFrames: number | null
  readonly missingFrames: number | null
  /** e.g. `freeze_previous_frame`. */
  readonly fillPolicy: string | null
  /** ISO timestamp of the publisher's last availability check. */
  readonly lastChecked: string | null
}

export interface DsaMetadata {
  readonly title: string | null
  readonly description: string | null
  readonly creator: string | null
  /** ISO timestamps as written. */
  readonly created: string | null
  readonly modified: string | null
  /** `realtime` | `forecast` | `reanalysis` … as written. */
  readonly productType: string | null
  readonly categories: readonly string[]
  readonly keywords: readonly string[]
  readonly units: string | null
  readonly sourceUrl: string | null
  readonly completeness: DsaCompleteness | null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(str).filter((s): s is string => s !== null) : []
}

/**
 * A field the schema localises as `{ en: "…", es: "…" }` — or, in an
 * older file, writes as a plain string. Prefers the requested language,
 * then English, then whatever the file has.
 */
function localized(value: unknown, lang: string): string | null {
  const plain = str(value)
  if (plain) return plain
  const record = asRecord(value)
  if (!record) return null
  const base = lang.toLowerCase().split('-')[0] ?? 'en'
  return str(record[base]) ?? str(record.en) ?? Object.values(record).map(str).find(Boolean) ?? null
}

/** Keywords that name the encoding rather than the data — noise to a visitor. */
const ENCODING_KEYWORDS = new Set(['vp9', 'vp8', 'av1', 'h264', 'h265', 'hevc', 'dash', 'hls', 'mp4', 'webm'])

/**
 * The descriptor's metadata, or null for something that is not a
 * descriptor at all. Never throws.
 */
export function parseDsaMetadata(raw: unknown, lang = 'en'): DsaMetadata | null {
  const dsa = asRecord(raw)
  if (!dsa) return null
  const availability = asRecord(dsa.dataAvailability)
  const links = asRecord(dsa.links)
  return {
    title: localized(dsa.title, lang),
    description: localized(dsa.description, lang),
    creator: str(dsa.creator),
    created: str(dsa.created),
    modified: str(dsa.modified),
    productType: str(dsa.dataProductType),
    categories: strings(dsa.categories),
    keywords: strings(dsa.keywords).filter(k => !ENCODING_KEYWORDS.has(k.toLowerCase())),
    units: str(dsa.units),
    sourceUrl: str(links?.source),
    completeness: availability
      ? {
          status: str(availability.status),
          expectedFrames: num(availability.expectedFrameCount),
          realFrames: num(availability.realFrameCount),
          filledFrames: num(availability.filledFrameCount),
          missingFrames: num(availability.missingFrameCount),
          fillPolicy: str(availability.fillPolicy),
          lastChecked: str(availability.lastChecked),
        }
      : null,
  }
}

// ---------------------------------------------------------------------------
// Prompt text
// ---------------------------------------------------------------------------

/** `2026-08-22T15:30:00Z` → `2026-08-22 15:30 UTC`; anything unparsable as written. */
function utc(isoOrMs: string | number): string {
  const d = new Date(isoOrMs)
  if (Number.isNaN(d.getTime())) return String(isoOrMs)
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

/**
 * A frame's instant as the docent should say it. An annual stream's
 * frames stand for years, and a monthly stream's for months: the day
 * and time of each are where the publisher put the origin, not data
 * (see timelineTrackCanvas.isAnnualCadence and isMonthlyCadence, whose
 * bounds these are), so they are given as "2075" and "Feb 2024".
 */
function frameStamp(timeline: DsaTimeline, ms: number): string {
  if (timeline.cadenceMs >= 365 * 86_400_000) return String(new Date(ms).getUTCFullYear())
  if (timeline.cadenceMs >= 28 * 86_400_000) {
    return new Date(ms).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
  }
  return utc(ms)
}

/** 900 000 ms → "15 minutes"; 86 400 000 → "1 day"; a mean Gregorian month → "1 month", year → "1 year". */
export function describeCadence(ms: number): string {
  // Annual streams step by the mean Gregorian year (31 556 952 s), which
  // is no whole number of days: it would otherwise read "31556952 seconds".
  if (ms >= 365 * 86_400_000) {
    const years = Math.round((ms / (365.2425 * 86_400_000)) * 10) / 10
    return `${years} year${years === 1 ? '' : 's'}`
  }
  // Monthly streams step by the mean Gregorian month (2 629 746 s), for
  // the same reason; a calendar month of 28 to 31 days is one month too.
  if (ms >= 28 * 86_400_000) {
    const exact = ms / ((365.2425 * 86_400_000) / 12)
    const whole = Math.round(exact)
    const months = Math.abs(exact - whole) < 0.1 ? whole : Math.round(exact * 10) / 10
    return `${months} month${months === 1 ? '' : 's'}`
  }
  const units: Array<[number, string]> = [
    [86_400_000, 'day'],
    [3_600_000, 'hour'],
    [60_000, 'minute'],
    [1_000, 'second'],
  ]
  for (const [size, name] of units) {
    if (ms >= size && ms % size === 0) {
      const n = ms / size
      return `${n} ${name}${n === 1 ? '' : 's'}`
    }
  }
  return `${Math.round(ms / 1000)} seconds`
}

const FILL_POLICY_WORDS: Record<string, string> = {
  freeze_previous_frame: 'by repeating the previous frame',
}

/**
 * The lines Orbit gets about the stream on the globe. `frame` is the
 * frame on screen, when there is a playing video to read it from.
 * Empty string when neither half has anything to say.
 */
export function describeStreamForDocent(
  meta: DsaMetadata | null,
  timeline: DsaTimeline | null,
  frame: number | null = null,
): string {
  const lines: string[] = []
  const product = meta?.productType

  if (product) lines.push(`Product type: ${product}`)
  // Every stream with a .dsa is one of Pachamama Studios' own: the
  // visualization is theirs, the data is the source's. Said here, beside
  // the facts, so the credit is right even when the prompt's general
  // identity section gets less of the model's attention.
  if (meta) {
    const pipeline = meta.creator ? ` (pipeline "${meta.creator}")` : ''
    const data = meta.sourceUrl ? `; data from ${meta.sourceUrl}` : ''
    lines.push(`Visualization: produced by Pachamama Studios${pipeline}${data}`)
  }
  if (meta?.sourceUrl) lines.push(`Original data source (data provider, not the maker of the visualization): ${meta.sourceUrl}`)
  if (meta?.units) lines.push(`Units: ${meta.units}`)
  if (meta?.keywords.length) lines.push(`Descriptor keywords: ${meta.keywords.join(', ')}`)

  if (timeline) {
    lines.push(
      `Time coverage: ${frameStamp(timeline, firstFrameDateMs(timeline))} to ${frameStamp(timeline, lastFrameDateMs(timeline))} — ` +
      `one frame every ${describeCadence(timeline.cadenceMs)}, ${timeline.frameCount} frames`,
    )
  }
  if (meta?.modified) {
    lines.push(`${product === 'forecast' ? 'Forecast published' : 'Last updated'}: ${utc(meta.modified)}`)
  }

  const c = meta?.completeness
  if (c) {
    const parts: string[] = []
    if (c.realFrames !== null && c.expectedFrames !== null) {
      parts.push(`${c.realFrames} of ${c.expectedFrames} frames are real data`)
    }
    if (c.filledFrames) {
      const how = c.fillPolicy ? FILL_POLICY_WORDS[c.fillPolicy] ?? `(fill policy: ${c.fillPolicy})` : ''
      parts.push(`${c.filledFrames} are gaps filled ${how}`.trim())
    }
    if (c.missingFrames) parts.push(`${c.missingFrames} are missing`)
    // A bare status with no counts (a forecast writes `unknown`) tells a
    // visitor nothing, so it is only worth a line alongside numbers.
    if (parts.length) {
      lines.push(`Data completeness${c.status ? ` (${c.status})` : ''}: ${parts.join('; ')}`)
    }
    if (c.lastChecked) lines.push(`Availability last checked: ${utc(c.lastChecked)}`)
  }

  if (timeline && frame !== null) {
    const shownMs = dateAtFrameMs(timeline, frame)
    const kind = availabilityAtFrame(timeline, frame)
    let what: string | null
    if (kind === 'filled') {
      const span = timeline.availability.spans.find(s => frame >= s.startFrame && frame < s.startFrame + s.frameCount)
      what = span?.sourceFrame !== null && span?.sourceFrame !== undefined
        ? `a filled gap — no data arrived for this time, so it repeats the frame from ${frameStamp(timeline, dateAtFrameMs(timeline, span.sourceFrame))}`
        : 'a filled gap — no data arrived for this time'
    } else if (kind === 'real') {
      what = 'real data'
    } else if (kind === 'missing' || kind === 'estimated') {
      what = `${kind} (as the descriptor marks it)`
    } else {
      // `unknown`: the descriptor makes no claim either way.
      what = null
    }
    lines.push(`Frame on screen: ${frameStamp(timeline, shownMs)}${what ? ` — ${what}` : ''}`)
  }

  if (lines.length === 0) return ''
  return [
    'Stream descriptor (.dsa) — the publisher\'s own metadata for the stream on the globe. ' +
      'Answer questions about its source, time coverage, update time, cadence and data gaps from these lines, ' +
      'and say so when a question goes beyond them:',
    ...lines.map(l => `- ${l}`),
  ].join('\n')
}
