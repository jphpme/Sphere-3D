// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { afterEach, describe, expect, it } from 'vitest'
import {
  ANCHOR_MARKER_FALLBACK,
  ANCHOR_MARKER_KEY,
  anchorMarkerUrl,
  closeAnchorPanel,
  isAnchorPanelOpen,
  openAnchorPanel,
} from './anchorPanel'

describe('anchorMarkerUrl', () => {
  it('points at the stream host, with or without a trailing slash', () => {
    expect(anchorMarkerUrl('https://streams.example/')).toBe(`https://streams.example/${ANCHOR_MARKER_KEY}`)
    expect(anchorMarkerUrl('https://streams.example')).toBe(`https://streams.example/${ANCHOR_MARKER_KEY}`)
  })

  it('uses the bundled copy when no host is configured, or the value is not a URL', () => {
    expect(anchorMarkerUrl(undefined)).toBe(ANCHOR_MARKER_FALLBACK)
    expect(anchorMarkerUrl('  ')).toBe(ANCHOR_MARKER_FALLBACK)
    expect(anchorMarkerUrl('not a url')).toBe(ANCHOR_MARKER_FALLBACK)
  })
})

describe('openAnchorPanel', () => {
  afterEach(() => {
    closeAnchorPanel()
  })

  const panel = () => document.getElementById('anchor-panel')
  const image = () => panel()!.querySelector<HTMLImageElement>('.anchor-panel-marker')!

  it('covers the page with the marker and a way out', () => {
    openAnchorPanel()
    expect(isAnchorPanelOpen()).toBe(true)
    expect(panel()!.getAttribute('role')).toBe('dialog')
    expect(panel()!.getAttribute('aria-label')).toBe('AYNI XR anchor')
    expect(image().alt).toBe('AYNI XR anchor marker')
    const close = panel()!.querySelector<HTMLButtonElement>('.anchor-panel-close')!
    expect(document.activeElement).toBe(close)
    close.click()
    expect(panel()).toBeNull()
    expect(isAnchorPanelOpen()).toBe(false)
  })

  it('opens once, however often it is asked', () => {
    openAnchorPanel()
    openAnchorPanel()
    expect(document.querySelectorAll('#anchor-panel')).toHaveLength(1)
  })

  it('falls back to the bundled copy when the first source fails, once', () => {
    openAnchorPanel(null, 'https://streams.example/missing.svg')
    expect(image().src).toBe('https://streams.example/missing.svg')
    image().dispatchEvent(new Event('error'))
    expect(new URL(image().src).pathname).toBe(ANCHOR_MARKER_FALLBACK)
    // A second failure must not loop.
    image().src = 'https://streams.example/still-missing.svg'
    image().dispatchEvent(new Event('error'))
    expect(image().src).toBe('https://streams.example/still-missing.svg')
  })

  it('closes on Escape and hands the focus back', () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    openAnchorPanel(trigger)
    panel()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(panel()).toBeNull()
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })
})
