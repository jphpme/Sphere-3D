// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * AYNI — an end-to-end check of the shared-AR marker artwork against the
 * detector, in a real browser: `public/ayni-xr-anchor.svg` is drawn on a
 * page as a sheet lying on a table, seen from several angles, and each
 * screenshot is handed to `detectMarker`.
 *
 * The unit tests draw the marker themselves, from the same layout the
 * detector reads; this draws the file people will actually print, mark
 * included, through a rasteriser neither side wrote.
 *
 *   npx tsx scripts/experiments/marker-detect-check.ts
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'
import { cameraPixelsToGray, detectMarker } from '../../src/services/sharedMarkerDetect'

const HERE = resolve(fileURLToPath(import.meta.url), '..')
const SVG = readFileSync(resolve(HERE, '../../public/ayni-xr-anchor.svg'), 'utf8')

interface View {
  name: string
  /** CSS transform of the sheet. */
  transform: string
  /** Sheet width in CSS px. */
  size: number
  background: string
  /** Whether the detector should find it. */
  expect: boolean
}

const VIEWS: View[] = [
  { name: 'flat, from above', transform: 'none', size: 360, background: '#6b5a48', expect: true },
  { name: 'turned 30°', transform: 'rotate(30deg)', size: 320, background: '#6b5a48', expect: true },
  { name: 'upside down', transform: 'rotate(180deg)', size: 320, background: '#2a2a2e', expect: true },
  { name: 'on a table, 55° slant', transform: 'perspective(900px) rotateX(55deg) rotateZ(20deg)', size: 380, background: '#8a7a66', expect: true },
  { name: 'on a table, 65° slant, far', transform: 'perspective(700px) rotateX(65deg) rotateZ(-140deg)', size: 220, background: '#3b4a3f', expect: true },
  { name: 'small in the picture', transform: 'rotate(-12deg)', size: 90, background: '#777', expect: true },
  { name: 'on a white table', transform: 'perspective(900px) rotateX(40deg) rotateZ(75deg)', size: 300, background: '#f2f2f2', expect: true },
  { name: 'mirrored', transform: 'scaleX(-1)', size: 320, background: '#6b5a48', expect: false },
]

async function main(): Promise<void> {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  let failures = 0
  for (const view of VIEWS) {
    await page.setContent(
      `<body style="margin:0;height:100vh;display:grid;place-items:center;background:${view.background};overflow:hidden">
         <div style="width:${view.size}px;height:${view.size}px;transform:${view.transform}">${SVG}</div>
       </body>`,
    )
    const png = PNG.sync.read(await page.screenshot())
    const gray = cameraPixelsToGray(new Uint8Array(png.data), png.width, png.height, false)
    const started = performance.now()
    const found = detectMarker(gray)
    const ms = performance.now() - started
    const ok = (found !== null) === view.expect
    if (!ok) failures++
    const where = found
      ? found.corners.map((c) => `(${c.x.toFixed(0)},${c.y.toFixed(0)})`).join(' ') + ` errors=${found.codeErrors}`
      : 'not found'
    console.log(`${ok ? '✓' : '✗'} ${view.name}: ${where} [${ms.toFixed(0)} ms]`)
  }
  await browser.close()
  if (failures > 0) process.exit(1)
}

void main()
