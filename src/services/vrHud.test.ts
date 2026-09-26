// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect } from 'vitest'
import { hudActionAt, voiceCaption, type VrHudState } from './vrHud'

const BASE: VrHudState = {
  datasetTitle: 'Sea Surface Temperature',
  isPlaying: false,
  hasVideo: true,
  isMuted: true,
  panelCount: 1,
  primaryIndex: 0,
  browseOpen: false,
}

const at = (state: VrHudState, u: number) => hudActionAt(state, { x: u, y: 0.5 })

describe('hudActionAt', () => {
  it('lays the bar out as play, mute, title, mic, browse, exit', () => {
    const state = { ...BASE, voice: { phase: 'idle' as const, caption: '' } }
    expect(at(state, 0.06)).toBe('play-pause')
    expect(at(state, 0.18)).toBe('mute')
    expect(at(state, 0.4)).toBeNull() // the title
    expect(at(state, 0.65)).toBe('voice')
    expect(at(state, 0.79)).toBe('browse')
    expect(at(state, 0.93)).toBe('exit-vr')
  })

  it('gives the mic band back to the title when voice is unavailable', () => {
    expect(at({ ...BASE, voice: null }, 0.65)).toBeNull()
    expect(at(BASE, 0.65)).toBeNull()
    // Browse and exit don't move with it.
    expect(at(BASE, 0.79)).toBe('browse')
    expect(at(BASE, 0.93)).toBe('exit-vr')
  })

  it('has no playback buttons for an image dataset', () => {
    const image = { ...BASE, hasVideo: false }
    expect(at(image, 0.06)).toBeNull()
    expect(at(image, 0.18)).toBeNull()
  })

  it('ignores a hit outside the bar', () => {
    expect(hudActionAt(BASE, { x: 0.93, y: 1.2 })).toBeNull()
    expect(hudActionAt(BASE, { x: 0.93, y: -0.1 })).toBeNull()
  })
})

describe('voiceCaption', () => {
  it('hides the strip when voice is unavailable or has nothing to say', () => {
    expect(voiceCaption(null)).toBeNull()
    expect(voiceCaption(undefined)).toBeNull()
    expect(voiceCaption({ phase: 'idle', caption: '' })).toBeNull()
  })

  it('prompts before anything is heard, then shows the transcript', () => {
    expect(voiceCaption({ phase: 'listening', caption: '' })).toEqual({
      label: 'Listening…',
      text: 'Ask Ayni Chatbot about the data, then tap the mic to send.',
    })
    expect(voiceCaption({ phase: 'listening', caption: 'where is the ozone hole' })?.text)
      .toBe('where is the ozone hole')
  })

  it('shows the question while Orbit thinks and the sentence while it speaks', () => {
    expect(voiceCaption({ phase: 'thinking', caption: 'where is the ozone hole' }))
      .toEqual({ label: 'Thinking…', text: 'where is the ozone hole' })
    expect(voiceCaption({ phase: 'speaking', caption: 'Over Antarctica.' }))
      .toEqual({ label: 'Ayni Chatbot', text: 'Over Antarctica.' })
  })

  it('keeps a finished reply up while it lingers, and says when hearing failed', () => {
    expect(voiceCaption({ phase: 'idle', caption: 'Over Antarctica.' }))
      .toEqual({ label: 'Ayni Chatbot', text: 'Over Antarctica.' })
    expect(voiceCaption({ phase: 'error', caption: '' })?.text)
      .toBe('Couldn’t hear that. Tap the mic to try again.')
  })
})
