// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * AYNI — a meeting end to end, in real browser pages: the audience
 * arrives first and waits, the presenter arrives and leads, the audience
 * cannot move the globe but the presenter can move it for them, and when
 * the presenter leaves nobody inherits the lead.
 *
 * Two ways to run it.
 *
 * Against local servers (the room Worker's dev door stands in for the
 * site's routes, with their checks left out):
 *
 *   npx wrangler dev --config workers/rooms/wrangler.toml --port 8797
 *   VITE_ROOM_WS_URL=ws://127.0.0.1:8797/api/room/ npm run dev -- --port 4173
 *   npx tsx scripts/experiments/meeting-check.ts
 *
 * Against a deployed site, through its real routes and signed links, with
 * the host key in the environment:
 *
 *   MEETING_CHECK_URL=https://vr.ayni.eu.com MEETING_API_KEY=... \
 *     npx tsx scripts/experiments/meeting-check.ts
 */

import { chromium, type Page } from 'playwright'

const BASE = process.env.MEETING_CHECK_URL ?? 'http://localhost:4173'
const ROOM_DEV = process.env.MEETING_CHECK_ROOM_DEV ?? 'http://127.0.0.1:8797'
const KEY = process.env.MEETING_API_KEY
const LOCAL = BASE.includes('localhost')
const LIVE = process.env.MEETING_CHECK_LIVE ?? 'https://vr.ayni.eu.com'

const chip = (page: Page): Promise<string> => page.locator('.room-chip').innerText()

async function until<T>(what: string, read: () => Promise<T>, ok: (value: T) => boolean, ms = 30000): Promise<T> {
  const deadline = Date.now() + ms
  let value = await read()
  while (!ok(value)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; last: ${JSON.stringify(value)}`)
    await new Promise((r) => setTimeout(r, 250)) // tick-drain-exempt: polling a browser from outside it
    value = await read()
  }
  return value
}

/** This page's camera, where the dev server's module graph can be reached; null on a deployed site. */
const camera = (page: Page): Promise<{ lat: number; lon: number; zoom: number } | null> =>
  page.evaluate(async () => {
    try {
      const load = new Function('p', 'return import(p)') as (p: string) => Promise<unknown>
      const mod = (await load('/services/roomSync.ts')) as { activeRoomSync(): { snapshot(): { view: unknown } } | null }
      return (mod.activeRoomSync()?.snapshot().view ?? null) as { lat: number; lon: number; zoom: number } | null
    } catch {
      return null
    }
  })

/** Close whatever the landing page opened over the globe. */
async function clearGlobe(page: Page): Promise<void> {
  for (let i = 0; i < 60; i++) {
    // No helper function inside: the script runner decorates named
    // functions with a helper the page does not have.
    const open = await page.evaluate(() => {
      // The loading screen covers the globe until the catalog has arrived.
      const covering = ['browse-overlay', 'loading-screen'].filter((id) => {
        const el = document.getElementById(id)
        return !!el && !el.classList.contains('hidden') && getComputedStyle(el).display !== 'none'
      })
      if (covering.includes('browse-overlay')) document.getElementById('browse-close')?.click()
      return covering.length > 0
    })
    if (!open) return
    await new Promise((r) => setTimeout(r, 400)) // tick-drain-exempt: the overlay closing
  }
}

async function drag(page: Page): Promise<void> {
  await page.mouse.move(500, 380)
  await page.mouse.down()
  await page.mouse.move(260, 300, { steps: 12 })
  await page.mouse.up()
  await new Promise((r) => setTimeout(r, 1200)) // tick-drain-exempt: the drag's own inertia
}

const near = (a: { lat: number; lon: number }, b: { lat: number; lon: number }): boolean =>
  Math.abs(a.lat - b.lat) < 0.5 && Math.abs(((((a.lon - b.lon + 180) % 360) + 360) % 360) - 180) < 0.5

/** The meeting's links: minted by the dev door locally, by the site's own route when deployed. */
async function createMeeting(): Promise<{ presenter: string; moderator: string; audience: string; forged: string }> {
  if (LOCAL) {
    const code = `M${Date.now().toString(36).toUpperCase().slice(-7)}`
    const res = await fetch(`${ROOM_DEV}/api/meeting-dev/${code}`, { method: 'POST' })
    if (res.status !== 204) throw new Error(`the dev door refused the meeting: ${res.status}`)
    const link = (seat?: string): string => `${BASE}/?room=${code}${seat ? `&st=dev.${seat}` : ''}`
    return { presenter: link('presenter'), moderator: link('moderator'), audience: link(), forged: '' }
  }
  if (!KEY) throw new Error('MEETING_API_KEY is needed to create a meeting on a deployed site')
  const refused = await fetch(`${BASE}/api/meeting`, { method: 'POST', headers: { Origin: BASE, 'X-Meeting-Api-Key': 'not-the-key' } })
  if (refused.status !== 401) throw new Error(`a wrong key got ${refused.status}, not 401`)
  console.log('✓ a wrong host key is refused')
  const res = await fetch(`${BASE}/api/meeting`, { method: 'POST', headers: { Origin: BASE, 'X-Meeting-Api-Key': KEY } })
  if (!res.ok) throw new Error(`creating the meeting failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { code: string; links: { presenter: string; moderator: string; audience: string } }
  // A moderator's link rewritten to claim the presenter's seat.
  return { ...body.links, forged: body.links.moderator.replace('.moderator.', '.presenter.') }
}

async function main(): Promise<void> {
  const links = await createMeeting()
  const browser = await chromium.launch()
  const open = async (url: string, viewport = { width: 1366, height: 768 }): Promise<Page> => {
    const page = await (await browser.newContext({ viewport })).newPage()
    if (LOCAL) {
      // The dev server has no backend: its catalog is answered from the live site.
      await page.route(/localhost:4173\/(api|dash|realtime)\//, async (route) => {
        try {
          const res = await route.fetch({ url: route.request().url().replace(BASE, LIVE) })
          await route.fulfill({ response: res })
        } catch {
          await route.abort()
        }
      })
    }
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.locator('.room-chip').waitFor({ state: 'attached', timeout: 30000 })
    return page
  }
  try {
    // The audience arrives first. In an open room that would make it the lead.
    const audience = await open(links.audience)
    await until('the audience to be told to wait', () => chip(audience), (t) => t.includes('waiting for the presenter'))
    console.log(`✓ lobby: "${await chip(audience)}"`)

    const moderator = await open(links.moderator)
    await until('the moderator to wait too', () => chip(moderator), (t) => t.includes('waiting for the presenter') && t.includes('2 here'))

    if (links.forged) {
      const forger = await (await browser.newContext()).newPage()
      await forger.goto(links.forged, { waitUntil: 'domcontentloaded' })
      await forger.locator('.room-chip').waitFor({ state: 'attached', timeout: 30000 })
      await new Promise((r) => setTimeout(r, 4000)) // tick-drain-exempt: giving a refused socket time to not connect
      const text = await chip(forger)
      if (!text.includes('connecting')) throw new Error(`a forged presenter link got in: "${text}"`)
      console.log('✓ a forged presenter link is turned away')
      await forger.context().close()
    }

    const presenter = await open(links.presenter)
    await until('the presenter to present', () => chip(presenter), (t) => t.includes('you present'))
    await until('the audience to watch', () => chip(audience), (t) => t.includes('watching'))
    await until('the moderator to moderate', () => chip(moderator), (t) => t.includes('moderating'))
    console.log(`✓ seats: "${await chip(presenter)}" / "${await chip(moderator)}" / "${await chip(audience)}"`)

    if (await camera(audience)) {
      // The same gesture on both pages, so a globe that stays put was held, not missed.
      await clearGlobe(presenter)
      await clearGlobe(audience)
      await new Promise((r) => setTimeout(r, 1500)) // tick-drain-exempt: the first state settling
      const before = (await camera(audience))!
      await drag(audience)
      const afterOwnDrag = (await camera(audience))!
      if (!near(before, afterOwnDrag)) throw new Error('the audience moved its own globe')
      console.log('✓ the audience cannot move the globe')
      await drag(presenter)
      const led = (await camera(presenter))!
      if (near(before, led)) throw new Error('the presenter’s drag did not move its globe')
      await until('the audience’s globe to follow the presenter', async () => (await camera(audience))!, (v) => near(v, led), 15000)
      console.log(`✓ the presenter moves it for them: ${led.lat.toFixed(1)}, ${led.lon.toFixed(1)}`)
    } else {
      console.log('– globe lock and follow: skipped (no module graph on a deployed site)')
    }

    await presenter.context().close()
    await until('the room to wait again', () => chip(audience), (t) => t.includes('waiting for the presenter'))
    console.log(`✓ no succession: "${await chip(audience)}"`)
  } finally {
    await browser.close()
  }
}

main().catch((err) => {
  console.error('✗', err instanceof Error ? err.message : err)
  process.exit(1)
})
