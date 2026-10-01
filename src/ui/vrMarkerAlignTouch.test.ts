// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createVrMarkerAlignTouch } from './vrMarkerAlignTouch'

describe('createVrMarkerAlignTouch', () => {
  let root: HTMLElement

  beforeEach(() => {
    root = document.createElement('div')
    document.body.appendChild(root)
  })

  afterEach(() => {
    root.remove()
    vi.useRealTimers()
  })

  const button = () => root.querySelector<HTMLButtonElement>('.vr-marker-scan')!
  const hint = () => root.querySelector<HTMLElement>('.vr-place-hint')!

  it('offers the scan, with no hint, until one starts', () => {
    const touch = createVrMarkerAlignTouch({ onToggle: () => {} })
    touch.mount(root)
    touch.setState(false, 'idle')
    expect(button().classList.contains('hidden')).toBe(false)
    expect(button().textContent).toBe('Scan marker')
    expect(hint().classList.contains('hidden')).toBe(true)
  })

  it('says what the scan is waiting for, and offers to stop it', () => {
    const touch = createVrMarkerAlignTouch({ onToggle: () => {} })
    touch.mount(root)
    touch.setState(true, 'searching')
    expect(button().textContent).toBe('Stop scanning')
    expect(hint().classList.contains('hidden')).toBe(false)
    expect(hint().textContent).toBe('Point the phone at the AYNI XR marker')
    touch.setState(true, 'steadying')
    expect(hint().textContent).toBe('Marker found. Hold still')
  })

  it('shows the aligned note, then takes it away', () => {
    vi.useFakeTimers()
    const touch = createVrMarkerAlignTouch({ onToggle: () => {} })
    touch.mount(root)
    touch.setState(false, 'aligned')
    expect(hint().textContent).toBe('Aligned to the marker')
    expect(hint().classList.contains('hidden')).toBe(false)
    vi.advanceTimersByTime(3100)
    expect(hint().classList.contains('hidden')).toBe(true)
    expect(button().textContent).toBe('Scan marker')
  })

  it('passes a tap on, and keeps it from the XR session', () => {
    const onToggle = vi.fn()
    const touch = createVrMarkerAlignTouch({ onToggle })
    touch.mount(root)
    button().click()
    expect(onToggle).toHaveBeenCalledTimes(1)
    const select = new Event('beforexrselect', { cancelable: true })
    button().dispatchEvent(select)
    expect(select.defaultPrevented).toBe(true)
  })

  it('stands aside while placement owns the screen', () => {
    const touch = createVrMarkerAlignTouch({ onToggle: () => {} })
    touch.mount(root)
    touch.setState(true, 'searching')
    touch.setHidden(true)
    expect(button().classList.contains('hidden')).toBe(true)
    expect(hint().classList.contains('hidden')).toBe(true)
    touch.setHidden(false)
    expect(button().classList.contains('hidden')).toBe(false)
  })

  it('removes itself on dispose', () => {
    const touch = createVrMarkerAlignTouch({ onToggle: () => {} })
    touch.mount(root)
    touch.dispose()
    expect(root.children).toHaveLength(0)
  })
})
