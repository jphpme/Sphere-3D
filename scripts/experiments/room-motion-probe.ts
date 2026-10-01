// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * AYNI — how smoothly a follower's globe moves while the lead drags its
 * own, and how far behind it is. The lead's globe is dragged steadily for
 * a few seconds; the follower's camera is sampled on every rendered frame.
 *
 * Reported for the follower, over the frames where the lead was moving:
 *
 *   - stalled frames: frames where the camera did not move at all (the
 *     eye reads a run of them as a stop);
 *   - jerk: the spread of per-frame movement relative to its mean (0 is
 *     perfectly even; above ~1 reads as stepping);
 *   - lag: how long after the lead the follower passed the same longitude.
 *
 * Needs a dev server and a local room, because it reads each page's camera
 * through the dev server's module graph:
 *
 *   npx wrangler dev --config workers/rooms/wrangler.toml --port 8797
 *   VITE_ROOM_WS_URL=ws://127.0.0.1:8797/api/room/ npm run dev -- --port 4173
 *   npx tsx scripts/experiments/room-motion-probe.ts
 *
 * ROOM_MOTION_LATENCY_MS adds that much delay to the follower's socket
 * messages, standing in for a real network.
 */

import { chromium, type Page } from 'playwright'

const BASE = process.env.ROOM_CHECK_URL ?? 'http://localhost:4173'
const LIVE = process.env.ROOM_CHECK_LIVE ?? 'https://vr.ayni.eu.com'
const LATENCY_MS = Number(process.env.ROOM_MOTION_LATENCY_MS ?? 0)
const CODE = `V${Date.now().toString(36).toUpperCase().slice(-5)}`

/** Records the camera's longitude on every frame, with the time; source text, see room-smoothness-probe.ts. */
const RECORD = `(async () => {
  const mod = await import("/services/roomSync.ts")
  const samples = []
  window.__motion = samples
  requestAnimationFrame(function tick(now) {
    const view = mod.activeRoomSync()?.snapshot().view
    if (view) samples.push([performance.timeOrigin + now, view.lon])
    requestAnimationFrame(tick)
  })
  return true
})()`

async function open(url: string, latencyMs: number, browser: Awaited<ReturnType<typeof chromium.launch>>): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  if (latencyMs > 0) {
    // Delay what the room sends this page, as a network would.
    await context.addInitScript(`(() => {
      const Native = window.WebSocket
      window.WebSocket = class extends Native {
        constructor(url, protocols) {
          super(url, protocols)
          const add = this.addEventListener.bind(this)
          this.addEventListener = (type, fn, opts) => {
            if (type !== "message") return add(type, fn, opts)
            return add(type, (ev) => setTimeout(() => fn.call(this, ev), ${latencyMs}), opts)
          }
        }
      }
    })()`)
  }
  const page = await context.newPage()
  await page.route(/localhost:4173\/(api|dash|realtime)\//, async (route) => {
    try {
      await route.fulfill({ response: await route.fetch({ url: route.request().url().replace(BASE, LIVE) }) })
    } catch {
      await route.abort()
    }
  })
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.locator('.room-chip').waitFor({ state: 'attached', timeout: 30000 })
  // Wait for the globe: the loading screen and the browser overlay out of the way.
  for (let i = 0; i < 80; i++) {
    const covered = await page.evaluate(`(() => {
      const shown = (id) => { const el = document.getElementById(id); return !!el && !el.classList.contains("hidden") && getComputedStyle(el).display !== "none" }
      if (shown("browse-overlay")) document.getElementById("browse-close")?.click()
      return shown("browse-overlay") || shown("loading-screen")
    })()`)
    if (!covered) break
    await new Promise((r) => setTimeout(r, 400)) // tick-drain-exempt: the page settling
  }
  return page
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=d3d11'] })
  try {
    const lead = await open(`${BASE}/?room=${CODE}`, 0, browser)
    await lead.waitForFunction(() => document.querySelector('.room-chip')?.textContent?.includes('you lead'), null, { timeout: 30000 })
    const follower = await open(`${BASE}/?room=${CODE}`, LATENCY_MS, browser)
    await follower.waitForFunction(() => document.querySelector('.room-chip')?.textContent?.includes('following'), null, { timeout: 30000 })
    await new Promise((r) => setTimeout(r, 2000)) // tick-drain-exempt: the first state settling
    await lead.evaluate(RECORD)
    await follower.evaluate(RECORD)

    // A steady drag on the lead: 3 s, one mouse step every 25 ms.
    await lead.mouse.move(800, 360)
    await lead.mouse.down()
    const t0 = Date.now()
    for (let i = 1; i <= 120; i++) {
      await lead.mouse.move(800 - i * 4, 360)
      const due = t0 + i * 25
      const wait = due - Date.now()
      if (wait > 0) await new Promise((r) => setTimeout(r, wait)) // tick-drain-exempt: pacing a drag in real time
    }
    await lead.mouse.up()
    await new Promise((r) => setTimeout(r, 2500)) // tick-drain-exempt: the drag's inertia and the follower catching up

    type S = [number, number][]
    const [a, b] = [(await lead.evaluate('window.__motion')) as S, (await follower.evaluate('window.__motion')) as S]
    const unwrap = (s: S): S => {
      let offset = 0
      return s.map(([t, lon], i) => {
        if (i > 0) {
          const d = lon - s[i - 1][1]
          if (d > 180) offset -= 360
          else if (d < -180) offset += 360
        }
        return [t, lon + offset]
      })
    }
    const [la, lb] = [unwrap(a), unwrap(b)]
    // The window where the lead was moving.
    const moving = la.filter((s, i) => i > 0 && Math.abs(s[1] - la[i - 1][1]) > 1e-4)
    const start = moving[0][0]
    const end = moving[moving.length - 1][0]
    const window = lb.filter(([t]) => t >= start && t <= end + 300)
    const steps = window.slice(1).map(([, lon], i) => Math.abs(lon - window[i][1]))
    const stalled = steps.filter((d) => d < 1e-5).length
    const mean = steps.reduce((x, y) => x + y, 0) / steps.length
    const sd = Math.sqrt(steps.reduce((x, y) => x + (y - mean) ** 2, 0) / steps.length)
    // Lag: when the follower passed the lead's midway longitude, against when the lead did.
    const mid = (la.find(([t]) => t >= start)![1] + la.find(([t]) => t >= end)![1]) / 2
    const crossed = (s: S): number | null => {
      for (let i = 1; i < s.length; i++) {
        if ((s[i - 1][1] - mid) * (s[i][1] - mid) <= 0) return s[i][0]
      }
      return null
    }
    const [ca, cb] = [crossed(la), crossed(lb)]
    const leadSteps = moving.slice(1).map(([, lon], i) => Math.abs(lon - moving[i][1]))
    const leadMean = leadSteps.reduce((x, y) => x + y, 0) / leadSteps.length
    const leadSd = Math.sqrt(leadSteps.reduce((x, y) => x + (y - leadMean) ** 2, 0) / leadSteps.length)
    console.log(`drag of ${(end - start).toFixed(0)} ms${LATENCY_MS ? `, follower's messages delayed ${LATENCY_MS} ms` : ''}:`)
    console.log(`  lead      frames ${moving.length}, jerk ${(leadSd / leadMean).toFixed(2)}`)
    console.log(
      `  follower  frames ${steps.length}, stalled ${stalled} (${((100 * stalled) / steps.length).toFixed(0)}%), ` +
        `jerk ${(sd / mean).toFixed(2)}, lag ${ca !== null && cb !== null ? `${(cb - ca).toFixed(0)} ms` : '?'}`,
    )
  } finally {
    await browser.close()
  }
}

main().catch((err) => {
  console.error('✗', err instanceof Error ? err.message : err)
  process.exit(1)
})
