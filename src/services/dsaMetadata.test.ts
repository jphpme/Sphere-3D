// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect } from 'vitest'
import { describeCadence, describeStreamForDocent, parseDsaMetadata } from './dsaMetadata'
import { parseDsaTimeline, type DsaTimeline } from './dsaTimeline'

/** The live Aircraft Traffic descriptor (2026-09-21), its 643 ranges cut to three. */
const AIRCRAFT = {
  $schema: 'https://pachamama-studios.stream/schemas/dsa-v1.6.json',
  schemaVersion: '1.6',
  id: '49554c183be6f416',
  title: { en: 'Aircraft Traffic' },
  description: { en: 'Real-time global aircraft positions from OpenSky ADS-B receivers.' },
  creator: 'Real-Time New',
  created: '2026-09-21T15:40:52Z',
  modified: '2026-09-21T15:40:52Z',
  categories: ['humans'],
  keywords: ['opensky', 'aircraft_tracking_grouped', 'vp9', 'dash'],
  type: 'stream',
  dataProductType: 'realtime',
  timeEnabled: true,
  timeRange: { start: '2026-08-22T15:30:00Z', end: '2026-09-21T15:30:00Z' },
  timeRangeEndMode: 'exclusive',
  timeTotalFrames: 2880,
  timeCadenceSeconds: 900,
  videoFrameRate: 24,
  dataAvailability: {
    status: 'partial',
    expectedFrameCount: 2880,
    realFrameCount: 2237,
    filledFrameCount: 643,
    missingFrameCount: 0,
    fillPolicy: 'freeze_previous_frame',
    lastChecked: '2026-09-21T15:40:49Z',
    ranges: [
      { startFrame: 4, frameCount: 1, availability: 'filled', sourceFrame: 3 },
      { startFrame: 8, frameCount: 1, availability: 'filled', sourceFrame: 7 },
      { startFrame: 100, frameCount: 4, availability: 'missing' },
    ],
  },
  links: { source: 'https://opensky-network.org/' },
}

function timeline(raw: unknown = AIRCRAFT): DsaTimeline {
  const parsed = parseDsaTimeline(raw)
  if (!parsed) throw new Error('fixture did not parse')
  return parsed
}

describe('parseDsaMetadata', () => {
  it('reads who made the stream, when, and how complete it is', () => {
    const meta = parseDsaMetadata(AIRCRAFT)
    expect(meta).toMatchObject({
      title: 'Aircraft Traffic',
      creator: 'Real-Time New',
      modified: '2026-09-21T15:40:52Z',
      productType: 'realtime',
      sourceUrl: 'https://opensky-network.org/',
      completeness: {
        status: 'partial',
        expectedFrames: 2880,
        realFrames: 2237,
        filledFrames: 643,
        missingFrames: 0,
        fillPolicy: 'freeze_previous_frame',
        lastChecked: '2026-09-21T15:40:49Z',
      },
    })
  })

  it('drops keywords that name the encoding rather than the data', () => {
    expect(parseDsaMetadata(AIRCRAFT)?.keywords).toEqual(['opensky', 'aircraft_tracking_grouped'])
  })

  it('prefers the requested language, then English, and accepts a plain string', () => {
    const bilingual = { ...AIRCRAFT, title: { en: 'Aircraft Traffic', es: 'Tráfico aéreo' } }
    expect(parseDsaMetadata(bilingual, 'es-MX')?.title).toBe('Tráfico aéreo')
    expect(parseDsaMetadata(AIRCRAFT, 'es')?.title).toBe('Aircraft Traffic')
    expect(parseDsaMetadata({ ...AIRCRAFT, title: 'Plain' })?.title).toBe('Plain')
  })

  it('keeps what a partial descriptor has, where the axis parser refuses it', () => {
    const noAxis = { creator: 'Someone', dataProductType: 'forecast' }
    expect(parseDsaTimeline(noAxis)).toBeNull()
    expect(parseDsaMetadata(noAxis)).toMatchObject({ creator: 'Someone', productType: 'forecast', completeness: null })
  })

  it('is null for something that is not a descriptor', () => {
    expect(parseDsaMetadata(null)).toBeNull()
    expect(parseDsaMetadata('<!doctype html>')).toBeNull()
    expect(parseDsaMetadata([1, 2])).toBeNull()
  })
})

describe('describeCadence', () => {
  it('names the unit a person would', () => {
    expect(describeCadence(900_000)).toBe('15 minutes')
    expect(describeCadence(3_600_000)).toBe('1 hour')
    expect(describeCadence(86_400_000)).toBe('1 day')
    expect(describeCadence(10_800_000)).toBe('3 hours')
  })
})

describe('describeStreamForDocent', () => {
  const meta = parseDsaMetadata(AIRCRAFT)

  it('gives Orbit the coverage, cadence, update time and completeness', () => {
    const text = describeStreamForDocent(meta, timeline())
    expect(text).toContain('Time coverage: 2026-08-22 15:30 UTC to 2026-09-21 15:15 UTC — one frame every 15 minutes, 2880 frames')
    expect(text).toContain('Last updated: 2026-09-21 15:40 UTC')
    expect(text).toContain('2237 of 2880 frames are real data; 643 are gaps filled by repeating the previous frame')
    expect(text).toContain('Original data source (data provider, not the maker of the visualization): https://opensky-network.org/')
    // AYNI: the visualization is credited to Pachamama Studios, the data to its source.
    expect(text).toContain('Visualization: produced by Pachamama Studios (pipeline "Real-Time New"); data from https://opensky-network.org/')
    expect(text).toContain('Availability last checked: 2026-09-21 15:40 UTC')
  })

  it('says when the frame on screen is a filled gap, and which frame it repeats', () => {
    expect(describeStreamForDocent(meta, timeline(), 4)).toContain(
      'Frame on screen: 2026-08-22 16:30 UTC — a filled gap — no data arrived for this time, so it repeats the frame from 2026-08-22 16:15 UTC',
    )
  })

  it('says when the frame on screen is real data', () => {
    expect(describeStreamForDocent(meta, timeline(), 5)).toContain('Frame on screen: 2026-08-22 16:45 UTC — real data')
  })

  it('words a forecast as a forecast', () => {
    const forecast = parseDsaMetadata({ ...AIRCRAFT, dataProductType: 'forecast' })
    const text = describeStreamForDocent(forecast, timeline())
    expect(text).toContain('Forecast published: 2026-09-21 15:40 UTC')
    expect(text).not.toContain('Last updated')
  })

  it('leaves out a completeness line with no numbers, and claims nothing for an unknown frame', () => {
    // The live AEMET forecast descriptor: status `unknown`, no counts, no ranges.
    const forecast = {
      ...AIRCRAFT,
      dataProductType: 'forecast',
      dataAvailability: { status: 'unknown', lastChecked: '2026-09-25T13:35:00Z' },
    }
    const text = describeStreamForDocent(parseDsaMetadata(forecast), timeline(forecast), 10)
    expect(text).not.toContain('Data completeness')
    expect(text).toMatch(/^- Frame on screen: 2026-08-22 18:00 UTC$/m)
  })

  it('describes what it has when the descriptor has no time axis', () => {
    const text = describeStreamForDocent(parseDsaMetadata({ creator: 'Someone' }), null, 12)
    expect(text).toContain('Visualization: produced by Pachamama Studios (pipeline "Someone")')
    expect(text).not.toContain('Time coverage')
    expect(text).not.toContain('Frame on screen')
  })

  it('says nothing when there is nothing to say', () => {
    expect(describeStreamForDocent(null, null)).toBe('')
  })
})
