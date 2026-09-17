// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect } from 'vitest'
import {
  availabilityAtFrame,
  dateAtFrameMs,
  dateAtVideoTimeMs,
  frameAtDateMs,
  frameAtProgress,
  frameAtVideoTime,
  lastFrameDateMs,
  parseDsaTimeline,
  progressAtDateMs,
  progressAtFrame,
  timelineDurationSeconds,
  timelineSpanMs,
  videoTimeForDateMs,
  videoTimeForFrame,
  type DsaTimeline,
} from './dsaTimeline'

/** The shape of a real file: aircraft traffic, 2880 frames of 15 minutes
 *  encoded at 24 fps — two minutes of video, thirty days of data. */
const AIRCRAFT = {
  $schema: 'https://pachamama-studios.stream/schemas/dsa-v1.6.json',
  schemaVersion: '1.6',
  id: '49554c183be6f416',
  timeEnabled: true,
  timeRange: { start: '2026-08-18T14:30:00Z', end: '2026-09-17T14:30:00Z' },
  timeRangeEndMode: 'exclusive',
  timeTotalFrames: 2880,
  timeCadenceSeconds: 900,
  videoFrameRate: 24,
  dataAvailability: {
    status: 'partial',
    expectedFrameCount: 2880,
    realFrameCount: 2242,
    filledFrameCount: 638,
    fillPolicy: 'freeze_previous_frame',
    ranges: [
      { startFrame: 4, frameCount: 1, availability: 'filled', sourceFrame: 3 },
      { startFrame: 0, frameCount: 1, availability: 'filled', sourceFrame: null },
      { startFrame: 100, frameCount: 4, availability: 'missing' },
    ],
  },
}

function parsed(raw: unknown = AIRCRAFT): DsaTimeline {
  const timeline = parseDsaTimeline(raw)
  if (!timeline) throw new Error('fixture did not parse')
  return timeline
}

const START = Date.parse('2026-08-18T14:30:00Z')
const CADENCE = 900_000

describe('parseDsaTimeline', () => {
  it('reads the axis a real file declares', () => {
    const t = parsed()
    expect(t.startMs).toBe(START)
    expect(t.frameCount).toBe(2880)
    expect(t.cadenceMs).toBe(CADENCE)
    expect(t.videoFrameRate).toBe(24)
    expect(t.endMode).toBe('exclusive')
    expect(t.declaredEndMs).toBe(Date.parse('2026-09-17T14:30:00Z'))
    // 30 days of data, 2 minutes of video — the whole point of the track.
    expect(timelineSpanMs(t)).toBe(30 * 24 * 3600 * 1000)
    expect(timelineDurationSeconds(t)).toBe(120)
  })

  it('accepts numeric strings, because the pipeline has written them', () => {
    const t = parsed({ ...AIRCRAFT, timeCadenceSeconds: '900.0', videoFrameRate: '24' })
    expect(t.cadenceMs).toBe(CADENCE)
    expect(t.videoFrameRate).toBe(24)
  })

  it('reads the deprecated timeFrameRate alias when videoFrameRate is absent', () => {
    const { videoFrameRate, ...rest } = AIRCRAFT as Record<string, unknown>
    void videoFrameRate
    expect(parsed({ ...rest, timeFrameRate: 8 }).videoFrameRate).toBe(8)
  })

  it('derives the cadence when only the range and frame count are stated', () => {
    const { timeCadenceSeconds, ...rest } = AIRCRAFT as Record<string, unknown>
    void timeCadenceSeconds
    expect(parsed(rest).cadenceMs).toBe(CADENCE)
    // Under last_frame the final frame *is* the declared end, so the
    // span divides by frameCount - 1 rather than frameCount.
    const lastFrame = parsed({
      ...rest,
      timeRangeEndMode: 'last_frame',
      timeTotalFrames: 3,
      timeRange: { start: '2026-08-18T14:30:00Z', end: '2026-08-18T15:00:00Z' },
    })
    expect(lastFrame.endMode).toBe('last_frame')
    expect(lastFrame.cadenceMs).toBe(900_000)
  })

  it('refuses an axis it cannot stand on, rather than guessing one', () => {
    expect(parseDsaTimeline(null)).toBeNull()
    expect(parseDsaTimeline('not an object')).toBeNull()
    expect(parseDsaTimeline({ ...AIRCRAFT, timeEnabled: false })).toBeNull()
    expect(parseDsaTimeline({ ...AIRCRAFT, timeRange: undefined })).toBeNull()
    expect(parseDsaTimeline({ ...AIRCRAFT, timeRange: { start: 'yesterday' } })).toBeNull()
    expect(parseDsaTimeline({ ...AIRCRAFT, timeTotalFrames: 0 })).toBeNull()
    expect(parseDsaTimeline({ ...AIRCRAFT, timeTotalFrames: undefined })).toBeNull()
    // No cadence and no usable range to derive one from.
    expect(
      parseDsaTimeline({ ...AIRCRAFT, timeCadenceSeconds: undefined, timeRange: { start: AIRCRAFT.timeRange.start } }),
    ).toBeNull()
    // No frame rate: the video playhead could not be mapped at all, and a
    // track frozen while the globe advances is worse than no track.
    const { videoFrameRate, ...noFps } = AIRCRAFT as Record<string, unknown>
    void videoFrameRate
    expect(parseDsaTimeline(noFps)).toBeNull()
  })

  it('keeps the availability spans sorted, with their source frame', () => {
    const t = parsed()
    expect(t.availability.status).toBe('partial')
    expect(t.availability.spans.map(s => s.startFrame)).toEqual([0, 4, 100])
    expect(t.availability.spans[1]).toMatchObject({ availability: 'filled', sourceFrame: 3 })
    expect(t.availability.spans[2]).toMatchObject({ availability: 'missing', sourceFrame: null })
  })

  it('drops malformed availability spans and maps unknown kinds to unknown', () => {
    const t = parsed({
      ...AIRCRAFT,
      dataAvailability: {
        status: 'partial',
        ranges: [
          { startFrame: 1, frameCount: 1, availability: 'who-knows' },
          { startFrame: 'x', frameCount: 2 },
          { frameCount: 2 },
          { startFrame: 5, frameCount: 0 },
          'nonsense',
        ],
      },
    })
    expect(t.availability.spans).toHaveLength(1)
    expect(t.availability.spans[0]).toMatchObject({ startFrame: 1, availability: 'unknown' })
  })

  it('treats a missing availability block as empty rather than fatal', () => {
    const { dataAvailability, ...rest } = AIRCRAFT as Record<string, unknown>
    void dataAvailability
    const t = parsed(rest)
    expect(t.availability.status).toBeNull()
    expect(t.availability.spans).toEqual([])
  })
})

describe('frame, date and video time', () => {
  it('maps the video playhead to the frame it is inside', () => {
    const t = parsed()
    expect(frameAtVideoTime(t, 0)).toBe(0)
    expect(frameAtVideoTime(t, 0.5)).toBe(12)
    expect(frameAtVideoTime(t, 1 / 24)).toBe(1)
    // The MPD runs 0.2 s past the last frame; the axis must not run with it.
    expect(frameAtVideoTime(t, 120.2)).toBe(2879)
    expect(frameAtVideoTime(t, 9999)).toBe(2879)
    expect(frameAtVideoTime(t, -5)).toBe(0)
    expect(frameAtVideoTime(t, Number.NaN)).toBe(0)
  })

  it('maps a frame to its instant, and clamps both ends', () => {
    const t = parsed()
    expect(dateAtFrameMs(t, 0)).toBe(START)
    expect(dateAtFrameMs(t, 96)).toBe(START + 96 * CADENCE) // 24 h in
    expect(dateAtFrameMs(t, 2879)).toBe(lastFrameDateMs(t))
    expect(dateAtFrameMs(t, 5000)).toBe(lastFrameDateMs(t))
    expect(dateAtFrameMs(t, -3)).toBe(START)
  })

  it('maps the playhead to an instant', () => {
    const t = parsed()
    expect(dateAtVideoTimeMs(t, 4)).toBe(START + 96 * CADENCE)
  })

  it('seeks into the middle of a frame, not onto its boundary', () => {
    const t = parsed()
    expect(videoTimeForFrame(t, 0)).toBeCloseTo(0.5 / 24, 10)
    expect(videoTimeForFrame(t, 96)).toBeCloseTo(96.5 / 24, 10)
    expect(videoTimeForFrame(t, 2879)).toBeLessThan(timelineDurationSeconds(t))
  })

  it('picks the nearest frame for an instant, and lands inside it', () => {
    const t = parsed()
    // A hair past frame 96's instant still resolves to frame 96.
    expect(frameAtDateMs(t, START + 96 * CADENCE + 1000)).toBe(96)
    // Past the halfway mark it resolves forward.
    expect(frameAtDateMs(t, START + 96 * CADENCE + CADENCE * 0.6)).toBe(97)
    const seek = videoTimeForDateMs(t, START + 96 * CADENCE)
    expect(frameAtVideoTime(t, seek)).toBe(96)
  })

  it('clamps a seek before the start and past the end', () => {
    const t = parsed()
    expect(frameAtVideoTime(t, videoTimeForDateMs(t, START - 10 * CADENCE))).toBe(0)
    expect(frameAtVideoTime(t, videoTimeForDateMs(t, START + 9999 * CADENCE))).toBe(2879)
  })
})

describe('axis position', () => {
  it('places a frame at the middle of its own cell', () => {
    const t = parsed()
    expect(progressAtFrame(t, 0)).toBeCloseTo(0.5 / 2880, 10)
    expect(progressAtFrame(t, 2879)).toBeCloseTo(2879.5 / 2880, 10)
  })

  it('round-trips a date through the axis position and back', () => {
    const t = parsed()
    for (const frame of [0, 1, 500, 1439, 2879]) {
      const p = progressAtFrame(t, frame)
      expect(frameAtProgress(t, p)).toBe(frame)
    }
  })

  it('reports a date position over the whole span, unclamped', () => {
    const t = parsed()
    expect(progressAtDateMs(t, START)).toBe(0)
    expect(progressAtDateMs(t, START + timelineSpanMs(t))).toBeCloseTo(1, 10)
    expect(progressAtDateMs(t, START + timelineSpanMs(t) * 2)).toBeCloseTo(2, 10)
  })

  it('survives a degenerate timeline without dividing by zero', () => {
    const t = parsed()
    const zeroSpan: DsaTimeline = { ...t, cadenceMs: 0 }
    expect(progressAtDateMs(zeroSpan, START)).toBe(0)
    expect(progressAtFrame(zeroSpan, 3)).toBe(0)
  })
})

describe('availabilityAtFrame', () => {
  it('finds a span in the middle of the axis by binary search', () => {
    const t = parsed()
    expect(availabilityAtFrame(t, 100)).toBe('missing')
    expect(availabilityAtFrame(t, 103)).toBe('missing')
    expect(availabilityAtFrame(t, 99)).toBe('real')
    expect(availabilityAtFrame(t, 104)).toBe('real')
  })

  it('treats a frame inside no span as real when the status says so', () => {
    const t = parsed()
    expect(availabilityAtFrame(t, 2000)).toBe('real')
  })

  it('says unknown when the file has no usable availability block', () => {
    const { dataAvailability, ...rest } = AIRCRAFT as Record<string, unknown>
    void dataAvailability
    expect(availabilityAtFrame(parsed(rest), 10)).toBe('unknown')
  })

  it('clamps a frame outside the axis before looking it up', () => {
    const t = parsed()
    expect(availabilityAtFrame(t, -1)).toBe('filled')
    expect(availabilityAtFrame(t, 99_999)).toBe('real')
  })
})
