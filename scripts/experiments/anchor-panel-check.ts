// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * AYNI — the Show anchor button, checked in a real browser at the sizes of
 * real devices: the panel is opened from its button, the screen is
 * captured, and the capture is handed to the marker detector. A marker
 * the detector finds, filling the short side of the screen, is the
 * panel doing its job.
 *
 * Needs a dev server on :4173 (`npm run dev -- --port 4173`).
 *
 *   npx tsx scripts/experiments/anchor-panel-check.ts
 */

import { chromium } from 'playwright'
import { PNG } from 'pngjs'
import { cameraPixelsToGray, detectMarker } from '../../src/services/sharedMarkerDetect'

const BASE = process.env.ANCHOR_CHECK_URL ?? 'http://localhost:4173/'

const DEVICES = [
  { name: 'phone, portrait', width: 412, height: 915, scale: 2.6 },
  { name: 'phone, landscape', width: 915, height: 412, scale: 2.6 },
  { name: 'tablet, portrait', width: 800, height: 1280, scale: 2 },
  { name: 'tablet, landscape', width: 1280, height: 800, scale: 2 },
  { name: 'small square-ish screen', width: 540, height: 600, scale: 1 },
]

async function main(): Promise<void> {
  const browser = await chromium.launch()
  let failures = 0
  for (const device of DEVICES) {
    const context = await browser.newContext({
      viewport: { width: device.width, height: device.height },
      deviceScaleFactor: device.scale,
      hasTouch: true,
    })
    const page = await context.newPage()
    const sources: string[] = []
    page.on('requestfinished', (request) => {
      if (request.url().includes('ayni-xr-anchor')) sources.push(request.url())
    })
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    // Clicked through the DOM: on some sizes the landing page opens the
    // dataset browser over the corner, and what is under test here is the
    // panel, not the way to it.
    await page.locator('#anchor-btn[data-wired="true"]').waitFor({ state: 'attached' })
    await page.evaluate(() => document.getElementById('anchor-btn')?.click())
    const qr = page.locator(".anchor-panel-qr svg path")
    await qr.waitFor({ state: "attached" })
    const marker = page.locator('.anchor-panel-marker')
    await marker.waitFor({ state: 'visible' })
    await page.waitForFunction(() => {
      const img = document.querySelector<HTMLImageElement>('.anchor-panel-marker')
      return !!img && img.complete && img.naturalWidth > 0
    })
    const box = (await marker.boundingBox())!
    const png = PNG.sync.read(await page.screenshot())
    const found = detectMarker(cameraPixelsToGray(new Uint8Array(png.data), png.width, png.height, false))
    // The square should take the whole short side, less the header in portrait-ish layouts.
    const short = Math.min(device.width, device.height)
    const fills = box.width >= short - 230 && Math.abs(box.width - box.height) < 1
    const inside = box.x >= -0.5 && box.y >= -0.5 && box.x + box.width <= device.width + 0.5 && box.y + box.height <= device.height + 0.5
    const ok = found !== null && fills && inside
    if (!ok) failures++
    console.log(
      `${ok ? '✓' : '✗'} ${device.name} ${device.width}x${device.height}: marker ${box.width.toFixed(0)}x${box.height.toFixed(0)} css px, ` +
        `${found ? 'detected' : 'NOT detected'}, from ${sources.at(-1) ?? 'nowhere'}`,
    )
    await context.close()
  }
  await browser.close()
  if (failures > 0) process.exit(1)
}

void main()
