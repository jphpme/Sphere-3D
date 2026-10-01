// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * AYNI — is a dataset smoother alone than in a shared session? Plays one
 * dataset in three arrangements and measures what a viewer sees:
 *
 *   - solo:        one page, no room;
 *   - two solos:   two pages, no room (the control for the next one: two
 *                  heavy pages on one machine compete whether or not they
 *                  are in a room);
 *   - room:        a lead and a follower, in a room.
 *
 * Per page: video frames actually presented per second (from
 * requestVideoFrameCallback, so a frame decoded and never shown does not
 * count), the longest gap between two presented frames, rendering frames
 * slower than 50 ms, dropped frames, and main-thread long tasks.
 *
 *   SMOOTH_DATASET=R2_DASH_eeaa0d52c4fce867 SMOOTH_URL=https://vr.ayni.eu.com \
 *     npx tsx scripts/experiments/room-smoothness-probe.ts
 */

import { chromium, type Browser, type Page } from 'playwright'

const BASE = process.env.SMOOTH_URL ?? 'https://vr.ayni.eu.com'
const DATASET = process.env.SMOOTH_DATASET ?? 'R2_DASH_eeaa0d52c4fce867'
const SECONDS = Number(process.env.SMOOTH_SECONDS ?? 20)

interface Sample {
  presentedFps: number
  worstGapMs: number
  slowRenderFrames: number
  renderFrames: number
  dropped: number
  longTaskMs: number
  renderer: string
}

/**
 * Install the counters in a page; they start at once. Passed as source
 * text: the script runner names the functions it compiles with a helper
 * the page does not have.
 */
const INSTALL = `(() => {
  const video = Array.from(document.querySelectorAll("video")).find((v) => v.duration > 0 && !v.paused)
  if (!video) return false
  const s = { presented: 0, last: 0, worstGap: 0, slow: 0, frames: 0, longTask: 0, t0: performance.now(), drop0: video.getVideoPlaybackQuality().droppedVideoFrames }
  window.__smooth = s
  window.__smoothVideo = video
  video.requestVideoFrameCallback(function onFrame(now) {
    if (s.last) s.worstGap = Math.max(s.worstGap, now - s.last)
    s.last = now
    s.presented++
    video.requestVideoFrameCallback(onFrame)
  })
  let prev = performance.now()
  requestAnimationFrame(function tick(now) {
    s.frames++
    if (now - prev > 50) s.slow++
    prev = now
    requestAnimationFrame(tick)
  })
  try {
    new PerformanceObserver((list) => { for (const e of list.getEntries()) s.longTask += e.duration })
      .observe({ type: "longtask", buffered: false })
  } catch {}
  return true
})()`

const install = (page: Page): Promise<boolean> => page.evaluate(INSTALL) as Promise<boolean>

const read = (page: Page): Promise<Sample> =>
  page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>
    const s = w.__smooth as { presented: number; worstGap: number; slow: number; frames: number; longTask: number; t0: number; drop0: number }
    const video = w.__smoothVideo as HTMLVideoElement
    const seconds = (performance.now() - s.t0) / 1000
    const gl = document.createElement('canvas').getContext('webgl')
    const info = gl?.getExtension('WEBGL_debug_renderer_info')
    return {
      presentedFps: s.presented / seconds,
      worstGapMs: s.worstGap,
      slowRenderFrames: s.slow,
      renderFrames: s.frames,
      dropped: video.getVideoPlaybackQuality().droppedVideoFrames - s.drop0,
      longTaskMs: s.longTask,
      renderer: info && gl ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)).slice(0, 60) : '?',
    }
  })

async function openPlaying(browser: Browser, url: string, lead: boolean): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /Got it|No thanks/ }).first().click({ timeout: 8000 }).catch(() => {})
  await page.waitForFunction(() => Array.from(document.querySelectorAll('video')).some((v) => v.duration > 0), null, { timeout: 90000 })
  if (lead) {
    // Start it if the page left it paused; a follower is started by the room.
    const paused = await page.evaluate(() => Array.from(document.querySelectorAll('video')).find((v) => v.duration > 0)?.paused ?? true)
    if (paused) await page.evaluate(() => document.getElementById('play-btn')?.click())
  }
  await page.waitForFunction(() => Array.from(document.querySelectorAll('video')).some((v) => v.duration > 0 && !v.paused && v.currentTime > 1), null, { timeout: 90000 })
  return page
}

async function measure(label: string, pages: [string, Page][]): Promise<void> {
  for (const [, page] of pages) if (!(await install(page))) throw new Error(`${label}: no playing video`)
  await new Promise((r) => setTimeout(r, SECONDS * 1000)) // tick-drain-exempt: sampling real playback
  for (const [name, page] of pages) {
    const s = await read(page)
    console.log(
      `  ${`${label} / ${name}`.padEnd(22)} shown ${s.presentedFps.toFixed(1)} fps, worst gap ${s.worstGapMs.toFixed(0)} ms, ` +
        `slow frames ${s.slowRenderFrames}/${s.renderFrames}, dropped ${s.dropped}, long tasks ${s.longTaskMs.toFixed(0)} ms` +
        (name === pages[0][0] && label === 'solo' ? `  [${s.renderer}]` : ''),
    )
  }
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=d3d11'] })
  const page = `${BASE}/dataset/${DATASET}`
  try {
    console.log(`${DATASET}, ${SECONDS} s each:`)
    const solo = await openPlaying(browser, page, true)
    await measure('solo', [['page', solo]])
    await solo.context().close()

    const a = await openPlaying(browser, page, true)
    const b = await openPlaying(browser, page, true)
    await measure('two solos', [['a', a], ['b', b]])
    await a.context().close()
    await b.context().close()

    const code = `S${Date.now().toString(36).toUpperCase().slice(-5)}`
    const lead = await openPlaying(browser, `${page}?room=${code}`, true)
    const follower = await openPlaying(browser, `${BASE}/?room=${code}`, false)
    await measure('room', [['lead', lead], ['follower', follower]])
  } finally {
    await browser.close()
  }
}

main().catch((err) => {
  console.error('✗', err instanceof Error ? err.message : err)
  process.exit(1)
})
