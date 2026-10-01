// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * AYNI — a shared session end to end, in two real browser pages against
 * a local room: the first page in leads, the second follows, and what the
 * lead does to its dataset and playhead shows up on the follower.
 *
 * Needs two servers:
 *
 *   npx wrangler dev --config workers/rooms/wrangler.toml --port 8787
 *   VITE_ROOM_WS_URL=ws://localhost:8787/api/room/ \
 *     VITE_REALTIME_DASH_BASE_URL=https://pachamama-studios.stream/ \
 *     npm run dev -- --port 4173
 *
 * The dev server has no backend, so its catalog and streams are answered
 * from the live site (ROOM_CHECK_LIVE). The AR half — the sphere's
 * orientation — is not reachable from a headless browser; it is covered
 * by unit tests and needs phones.
 *
 *   npx tsx scripts/experiments/room-sync-check.ts
 */

import { chromium, type Page } from 'playwright'

const BASE = process.env.ROOM_CHECK_URL ?? 'http://localhost:4173'
const LIVE = process.env.ROOM_CHECK_LIVE ?? 'https://vr.ayni.eu.com'
const CODE = `T${Date.now().toString(36).toUpperCase().slice(-5)}`

async function open(page: Page): Promise<void> {
  await page.route(/localhost:4173\/(api|dash|realtime)\//, async (route) => {
    try {
      const res = await route.fetch({ url: route.request().url().replace(BASE, LIVE) })
      await route.fulfill({ response: res })
    } catch {
      await route.abort()
    }
  })
  await page.goto(`${BASE}/?room=${CODE}`, { waitUntil: 'domcontentloaded' })
  await page.locator('.room-chip').waitFor({ state: 'attached', timeout: 20000 })
}

const chip = (page: Page): Promise<string> => page.locator('.room-chip').innerText()
const title = (page: Page): Promise<string> =>
  page.evaluate(() => document.getElementById('info-title')?.textContent?.trim() ?? '')
const video = (page: Page): Promise<{ time: number; paused: boolean; duration: number } | null> =>
  page.evaluate(() => {
    const v = Array.from(document.querySelectorAll("video")).find((el) => el.duration > 0)
    return v ? { time: v.currentTime, paused: v.paused, duration: v.duration } : null
  })

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

async function main(): Promise<void> {
  const browser = await chromium.launch()
  const lead = await (await browser.newContext({ viewport: { width: 1366, height: 768 } })).newPage()
  const follower = await (await browser.newContext({ viewport: { width: 412, height: 915 } })).newPage()
  try {
    await open(lead)
    await until('the lead to be told it leads', () => chip(lead), (text) => text.includes('you lead'))
    await open(follower)
    await until('the follower to be told it follows', () => chip(follower), (text) => text.includes('following'))
    await until('the lead to count two', () => chip(lead), (text) => text.includes('2 here'))
    console.log(`✓ roles: "${await chip(lead)}" / "${await chip(follower)}"`)

    // The lead loads a dataset; the follower should load the same one.
    await lead.getByRole('button', { name: /Got it|No thanks/ }).first().click({ timeout: 3000 }).catch(() => {})
    await lead.getByRole('button', { name: /^Load/ }).first().click({ timeout: 15000 })
    const leadTitle = await until('the lead to show its dataset', () => title(lead), (text) => text.length > 0)
    await until('the follower to show the same dataset', () => title(follower), (text) => text === leadTitle, 45000)
    console.log(`✓ dataset followed: "${leadTitle}"`)

    // The lead presses play; both play, in step.
    await until('the lead’s video to be ready', () => video(lead), (v) => !!v, 45000)
    await lead.locator('#play-btn').click()
    await until('the lead to play', () => video(lead), (v) => !!v && !v.paused && v.time > 1, 45000)
    await until('the follower to play', () => video(follower), (v) => !!v && !v.paused, 45000)
    await new Promise((r) => setTimeout(r, 4000)) // tick-drain-exempt: letting two real decoders settle
    const [a, b] = [await video(lead), await video(follower)]
    const apart = Math.abs((a!.time / a!.duration - b!.time / b!.duration) * a!.duration)
    if (apart > 1.2) throw new Error(`playing ${apart.toFixed(2)} s apart`)
    console.log(`✓ playing in step: ${apart.toFixed(2)} s apart`)

    // The lead pauses and seeks; the follower holds the same frame.
    await lead.locator('#play-btn').click()
    await lead.evaluate(() => {
      const v = Array.from(document.querySelectorAll("video")).find((el) => el.duration > 0)!
      v.currentTime = v.duration * 0.6
    })
    const target = (await video(lead))!
    await until(
      'the follower to pause on the lead’s frame',
      () => video(follower),
      (v) => !!v && v.paused && Math.abs(v.time / v.duration - target.time / target.duration) * target.duration < 0.3,
      20000,
    )
    console.log(`✓ pause and seek followed: lead at ${target.time.toFixed(2)} s, follower at ${(await video(follower))!.time.toFixed(2)} s`)

    // The lead leaves; the follower inherits the room.
    await lead.context().close()
    await until('the follower to become the lead', () => chip(follower), (text) => text.includes('you lead'))
    console.log(`✓ succession: "${await chip(follower)}"`)
  } finally {
    await browser.close()
  }
}

main().catch((err) => {
  console.error('✗', err instanceof Error ? err.message : err)
  process.exit(1)
})
