/**
 * Tests for the node-mode catalog fetch path in `dataService.ts`.
 *
 * Coverage:
 *   - VITE_CATALOG_SOURCE=node hits `/api/v1/catalog`, maps wire
 *     fields to the Dataset shape, and injects the local sample
 *     tours.
 *   - The supported-format filter and weight-DESC sort apply.
 *   - Hidden / HIDDEN_TOUR_IDS rows are filtered out.
 *   - A non-2xx response surfaces as a thrown error.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DataService } from './dataService'

const ORIGINAL_SOURCE = import.meta.env.VITE_CATALOG_SOURCE
const ORIGINAL_REALTIME_DASH_BASE_URL = import.meta.env.VITE_REALTIME_DASH_BASE_URL

function mockNodeCatalog(datasets: unknown[], realtimeIndex: unknown | null = null) {
  return vi.fn(async (input: RequestInfo | URL | string) => {
    if (String(input) === '/assets/realtime-dash-datasets.json') {
      if (realtimeIndex) {
        return new Response(JSON.stringify(realtimeIndex), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('', { status: 404 })
    }
    expect(String(input)).toBe('/api/v1/catalog')
    return new Response(JSON.stringify({ datasets }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

describe('DataService — node-mode', () => {
  beforeEach(() => {
    ;(import.meta.env as Record<string, string>).VITE_CATALOG_SOURCE = 'node'
    delete (import.meta.env as Record<string, string>).VITE_REALTIME_DASH_BASE_URL
  })

  afterEach(() => {
    if (ORIGINAL_SOURCE === undefined) {
      delete (import.meta.env as Record<string, string>).VITE_CATALOG_SOURCE
    } else {
      ;(import.meta.env as Record<string, string>).VITE_CATALOG_SOURCE = ORIGINAL_SOURCE
    }
    if (ORIGINAL_REALTIME_DASH_BASE_URL === undefined) {
      delete (import.meta.env as Record<string, string>).VITE_REALTIME_DASH_BASE_URL
    } else {
      ;(import.meta.env as Record<string, string>).VITE_REALTIME_DASH_BASE_URL = ORIGINAL_REALTIME_DASH_BASE_URL
    }
    vi.unstubAllGlobals()
  })

  it('fetches /api/v1/catalog and maps the wire shape into Dataset', async () => {
    vi.stubGlobal(
      'fetch',
      mockNodeCatalog([
        {
          id: 'DS001',
          title: 'Hurricane Helene 2024',
          format: 'video/mp4',
          dataLink: '/api/v1/datasets/DS001/manifest',
          organization: 'NOAA',
          weight: 100,
          enriched: { categories: { Theme: ['Atmosphere'] }, keywords: ['hurricane'] },
        },
        {
          id: 'DS002',
          title: 'Nighttime Lights',
          format: 'image/jpg',
          dataLink: '/api/v1/datasets/DS002/manifest',
          weight: 50,
        },
      ]),
    )
    const svc = new DataService()
    const datasets = await svc.fetchDatasets()

    // Two real datasets + two sample tours.
    expect(datasets).toHaveLength(4)

    const helene = datasets.find(d => d.id === 'DS001')!
    expect(helene.title).toBe('Hurricane Helene 2024')
    expect(helene.format).toBe('video/mp4')
    expect(helene.dataLink).toBe('/api/v1/datasets/DS001/manifest')
    expect(helene.organization).toBe('NOAA')
    expect(helene.enriched?.categories?.Theme).toEqual(['Atmosphere'])

    // Weight-descending sort puts the higher-weighted item first.
    expect(datasets[0].id).toBe('DS001')
  })

  it('injects the built-in sample tours so they show up in browse', async () => {
    vi.stubGlobal('fetch', mockNodeCatalog([]))
    const svc = new DataService()
    const datasets = await svc.fetchDatasets()
    const ids = datasets.map(d => d.id)
    expect(ids).toContain('SAMPLE_TOUR')
    expect(ids).toContain('SAMPLE_TOUR_CLIMATE_FUTURES')
  })

  it('filters hidden datasets and HIDDEN_TOUR_IDS', async () => {
    vi.stubGlobal(
      'fetch',
      mockNodeCatalog([
        {
          id: 'INTERNAL_SOS_687', // in HIDDEN_TOUR_IDS
          title: '360 Media',
          format: 'tour/json',
          dataLink: '/api/v1/datasets/INTERNAL_SOS_687/manifest',
        },
        {
          id: 'HIDDEN1',
          title: 'Hidden one',
          format: 'video/mp4',
          dataLink: '/api/v1/datasets/HIDDEN1/manifest',
          isHidden: true,
        },
        {
          id: 'BAD_FORMAT',
          title: 'Unsupported',
          format: 'audio/mpeg', // not supported
          dataLink: '/api/v1/datasets/BAD_FORMAT/manifest',
        },
      ]),
    )
    const svc = new DataService()
    const datasets = await svc.fetchDatasets()
    // Only the sample tours survive the filter.
    expect(datasets.map(d => d.id).sort()).toEqual(
      ['SAMPLE_TOUR', 'SAMPLE_TOUR_CLIMATE_FUTURES'].sort(),
    )
  })

  it('throws on a non-2xx response from the backend', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 503 })) as unknown as typeof fetch,
    )
    const svc = new DataService()
    await expect(svc.fetchDatasets()).rejects.toThrow(/Failed to fetch datasets/)
  })

  it('caches across calls so a second fetch does not re-hit the backend', async () => {
    const fetchStub = mockNodeCatalog([
      {
        id: 'DS001',
        title: 'One',
        format: 'video/mp4',
        dataLink: '/api/v1/datasets/DS001/manifest',
      },
    ])
    vi.stubGlobal('fetch', fetchStub)
    const svc = new DataService()
    await svc.fetchDatasets()
    await svc.fetchDatasets()
    expect(fetchStub).toHaveBeenCalledTimes(2)
  })

  it('prefixes real-time DASH titles and marks them for default borders', async () => {
    vi.stubGlobal(
      'fetch',
      mockNodeCatalog([], {
        baseUrl: 'https://cdn.example.com/ayni/',
        generatedAt: '2026-05-06T09:02:10Z',
        datasets: [
          {
            id: 'rt001',
            display_name: 'Lightning',
            type: 'stream',
            categories: ['atmosphere'],
            mpd: 'realtime/provider/lightning/stream.mpd',
          },
          {
            id: 'fc001',
            display_name: 'Forecast: Sea Level',
            type: 'forecast',
            categories: ['hydrosphere'],
            mpd: 'forecast/provider/sea_level/stream.mpd',
          },
        ],
      }),
    )

    const svc = new DataService()
    const datasets = await svc.fetchDatasets()
    const realtime = datasets.find(d => d.id === 'R2_DASH_rt001')
    const forecast = datasets.find(d => d.id === 'R2_DASH_fc001')

    expect(realtime?.title).toBe('Real Time: Lightning')
    expect(realtime?.realtimeKind).toBe('real-time')
    expect(realtime?.defaultBordersVisible).toBe(true)
    expect(realtime?.dataLink).toBe('https://cdn.example.com/ayni/realtime/provider/lightning/stream.mpd')
    expect(forecast?.title).toBe('Forecast: Sea Level')
    expect(forecast?.realtimeKind).toBe('forecast')
    expect(forecast?.defaultBordersVisible).toBe(true)
  })

  it('detects forecast kind from schema 1.2 dataProductType + new R2 path layout', async () => {
    // The pachamama-studios.stream index reorganised paths to
    // `global|regional/<realtime|forecast>/<org-slug>/<name>/...` and
    // replaced `type: 'forecast'` with `dataProductType`. The legacy
    // `mpd.startsWith('forecast/')` check no longer matches, so the
    // loader must read `dataProductType` (and tolerate `/forecast/`
    // in the path) or every forecast row is mislabelled real-time.
    vi.stubGlobal(
      'fetch',
      mockNodeCatalog([], {
        schemaVersion: '1.2',
        baseUrl: 'https://pachamama-studios.stream/',
        generatedAt: '2026-06-22T19:45:28Z',
        datasets: [
          {
            id: 'clouds_grouped',
            display_name: 'Global Cloud Cover',
            type: 'stream',
            dataProductType: 'realtime',
            organization: 'NOAA Science On a Sphere',
            categories: ['atmosphere'],
            units: '%',
            mpd: 'global/realtime/noaa-sos/clouds_grouped/stream.mpd',
          },
          {
            id: 'ecmwf_t2m_forecast',
            display_name: 'Forecast: Surface Temperature (ECMWF)',
            type: 'stream',
            dataProductType: 'forecast',
            organization: 'ECMWF Open Data',
            categories: ['atmosphere'],
            units: '°C',
            mpd: 'global/forecast/ecmwf-open-data/ecmwf_t2m_forecast/stream.mpd',
          },
        ],
      }),
    )

    const svc = new DataService()
    const datasets = await svc.fetchDatasets()
    const realtime = datasets.find(d => d.id === 'R2_DASH_clouds_grouped')
    const forecast = datasets.find(d => d.id === 'R2_DASH_ecmwf_t2m_forecast')

    expect(realtime?.realtimeKind).toBe('real-time')
    expect(realtime?.title).toBe('Real Time: Global Cloud Cover')
    expect(realtime?.organization).toBe('NOAA Science On a Sphere')
    expect(realtime?.dataLink).toBe('https://pachamama-studios.stream/global/realtime/noaa-sos/clouds_grouped/stream.mpd')

    expect(forecast?.realtimeKind).toBe('forecast')
    expect(forecast?.title).toBe('Forecast: Surface Temperature (ECMWF)')
    expect(forecast?.organization).toBe('ECMWF Open Data')
    expect(forecast?.dataLink).toBe('https://pachamama-studios.stream/global/forecast/ecmwf-open-data/ecmwf_t2m_forecast/stream.mpd')
  })

  it('preserves legacyId from the wire shape and falls back on lookup (1d/T)', async () => {
    // Tour files and other long-lived references hard-code SOS
    // legacy IDs (e.g. INTERNAL_SOS_768); post-cutover the catalog's
    // primary `id` is a ULID. The dataService maps the wire
    // `legacyId` field through and `getDatasetById` consults it as
    // a fallback so tours keep resolving without rewrites.
    vi.stubGlobal(
      'fetch',
      mockNodeCatalog([
        {
          id: '01KQFFCEE4Q7NQGJNFB0Z042MC',
          legacyId: 'INTERNAL_SOS_768',
          title: 'Hurricane Season - 2024',
          format: 'video/mp4',
          dataLink: '/api/v1/datasets/01KQFFCEE4Q7NQGJNFB0Z042MC/manifest',
        },
      ]),
    )
    const svc = new DataService()
    const datasets = await svc.fetchDatasets()
    const hurricane = datasets.find(d => d.id === '01KQFFCEE4Q7NQGJNFB0Z042MC')
    expect(hurricane?.legacyId).toBe('INTERNAL_SOS_768')

    // Direct ULID lookup still works.
    expect(svc.getDatasetById('01KQFFCEE4Q7NQGJNFB0Z042MC')?.id).toBe(
      '01KQFFCEE4Q7NQGJNFB0Z042MC',
    )
    // Legacy-ID lookup resolves to the same row via the fallback.
    expect(svc.getDatasetById('INTERNAL_SOS_768')?.id).toBe(
      '01KQFFCEE4Q7NQGJNFB0Z042MC',
    )
    // Unknown id still misses.
    expect(svc.getDatasetById('NONEXISTENT')).toBeUndefined()
  })
})
