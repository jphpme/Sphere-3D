// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * AYNI — what a shared session does to a follower's video, measured: a
 * lead and a follower play one dataset for a while, and every seek,
 * play, pause and stall on each page's video is counted, with how far
 * apart the two playheads are. A solo page plays the same dataset beside
 * them as the baseline.
 *
 * A follower that seeks, pauses or stalls more than the solo page is the
 * sync disturbing the player. Written after a report that playback in a
 * meeting was choppy.
 *
 *   ROOM_CHECK_URL=https://vr.ayni.eu.com npx tsx scripts/experiments/room-playback-probe.ts
 *
 * Needs the same servers as room-sync-check.ts when run locally.
 */

import { chromium, type Page } from 'playwright'

const BASE = process.env.ROOM_CHECK_URL ?? 'http://localhost:4173'
const LIVE = process.env.ROOM_CHECK_LIVE ?? 'https://vr.ayni.eu.com'
const SECONDS = Number(process.env.ROOM_PROBE_SECONDS ?? 45)
const CODE = `P${Date.now().toString(36).toUpperCase().slice(-5)}`
/** Slow the follower's CPU by this factor, to stand in for a phone. */
const THROTTLE = Number(process.env.ROOM_PROBE_THROTTLE ?? 1)

async function open(page: Page, url: string): Promise<void> {
  await page.route(/localhost:4173\/(api|dash|realtime)\//, async (route) => {
    try {
      const res = await route.fetch({ url: route.request().url().replace(BASE, LIVE) })
      await route.fulfill({ response: res })
    } catch {
      await route.abort()
    }
  })
  await page.goto(url, { waitUntil: 'domcontentloaded' })
}

/** Start counting the video's events; the counts live on the page. */
const watch = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const video = Array.from(document.querySelectorAll('video')).find((el) => el.duration > 0)
    if (!video) return false
    const counts: Record<string, number> = { seeking: 0, play: 0, pause: 0, waiting: 0, stalled: 0, ratechange: 0 }
    for (const name of Object.keys(counts)) video.addEventListener(name, () => { counts[name]++ })
    ;(window as unknown as { __probe: unknown }).__probe = { counts, video, start: video.currentTime }
    return true
  })

const read = (page: Page): Promise<{ counts: Record<string, number>; time: number; duration: number; paused: boolean; dropped: number; total: number } | null> =>
  page.evaluate(() => {
    const probe = (window as unknown as { __probe?: { counts: Record<string, number>; video: HTMLVideoElement } }).__probe
    if (!probe) return null
    const quality = probe.video.getVideoPlaybackQuality?.()
    return {
      counts: probe.counts,
      time: probe.video.currentTime,
      duration: probe.video.duration,
      paused: probe.video.paused,
      dropped: quality?.droppedVideoFrames ?? 0,
      total: quality?.totalVideoFrames ?? 0,
    }
  })

async function waitFor(what: string, ok: () => Promise<boolean>, ms = 60000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await ok())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 300)) // tick-drain-exempt: polling a browser from outside it
  }
}

async function main(): Promise<void> {
  const browser = await chromium.launch()
  const page = async (width: number, height: number): Promise<Page> =>
    (await browser.newContext({ viewport: { width, height } })).newPage()
  const lead = await page(1366, 768)
  const follower = await page(412, 915)
  const solo = await page(412, 915)
  try {
    await open(lead, `${BASE}/?room=${CODE}`)
    await lead.locator('.room-chip').waitFor({ state: 'attached', timeout: 30000 })
    await waitFor('the lead to lead', async () => (await lead.locator('.room-chip').innerText()).includes('you lead'))
    await open(follower, `${BASE}/?room=${CODE}`)
    await open(solo, `${BASE}/`)
    if (THROTTLE > 1) {
      for (const p of [follower, solo]) {
        const cdp = await p.context().newCDPSession(p)
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE })
      }
    }

    // The same dataset on the lead (the follower takes it from the room) and on the solo page.
    for (const p of [lead, solo]) {
      await p.getByRole('button', { name: /Got it|No thanks/ }).first().click({ timeout: 3000 }).catch(() => {})
      if (p === solo) await p.evaluate(() => document.getElementById('tools-menu-browse')?.click())
      await p.getByRole('button', { name: /^Load/ }).first().click({ timeout: 20000 })
    }
    for (const [name, p] of [['lead', lead], ['follower', follower], ['solo', solo]] as const) {
      await waitFor(`the ${name}'s video`, () => watch(p))
    }
    await lead.locator('#play-btn').click()
    await solo.evaluate(() => document.getElementById('play-btn')?.click())
    await waitFor('the lead to play', async () => !(await read(lead))!.paused)
    await waitFor('the follower to play', async () => !(await read(follower))!.paused)
    // Count from here: the start-up seek and play are not the complaint.
    for (const p of [lead, follower, solo]) await watch(p)

    const apart: number[] = []
    for (let s = 0; s < SECONDS; s++) {
      await new Promise((r) => setTimeout(r, 1000)) // tick-drain-exempt: sampling over real playback time
      const [a, b] = [await read(lead), await read(follower)]
      if (a && b) apart.push(Math.abs(a.time / a.duration - b.time / b.duration) * a.duration)
    }

    console.log(`over ${SECONDS} s${THROTTLE > 1 ? `, follower and solo CPU slowed ${THROTTLE}x` : ''}:`)
    for (const [name, p] of [['lead', lead], ['follower', follower], ['solo', solo]] as const) {
      const r = (await read(p))!
      console.log(
        `  ${name.padEnd(8)} seeks=${r.counts.seeking} plays=${r.counts.play} pauses=${r.counts.pause} ` +
          `stalls=${r.counts.waiting + r.counts.stalled} rate changes=${r.counts.ratechange} ` +
          `dropped=${r.dropped}/${r.total} frames  at ${r.time.toFixed(1)}/${r.duration.toFixed(1)} s`,
      )
    }
    apart.sort((x, y) => x - y)
    console.log(
      `  lead-follower gap: median ${apart[Math.floor(apart.length / 2)].toFixed(2)} s, ` +
        `worst ${apart[apart.length - 1].toFixed(2)} s`,
    )
  } finally {
    await browser.close()
  }
}

main().catch((err) => {
  console.error('✗', err instanceof Error ? err.message : err)
  process.exit(1)
})
