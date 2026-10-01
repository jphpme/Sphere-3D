// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import type { RoomStatus } from '../services/roomClient'
import { mountRoomChip, roomChipText } from './roomChip'

const status = (over: Partial<RoomStatus> = {}): RoomStatus => ({
  code: 'AB12CD',
  connected: true,
  role: 'lead',
  count: 3,
  meeting: false,
  seat: null,
  hasLead: true,
  ...over,
})

describe('roomChipText', () => {
  it('says who this device is in the room, and how many are there', () => {
    expect(roomChipText(status())).toBe('Shared session AB12CD · you lead · 3 here')
    expect(roomChipText(status({ role: 'follower' }))).toBe('Shared session AB12CD · following · 3 here')
  })

  it('says connecting until the room has answered', () => {
    expect(roomChipText(status({ connected: false, role: null }))).toBe('Shared session AB12CD · connecting…')
    expect(roomChipText(status({ role: null }))).toBe('Shared session AB12CD · connecting…')
  })
})

describe('roomChipText, in a meeting', () => {
  const meeting = (over: Partial<RoomStatus> = {}): RoomStatus => status({ meeting: true, seat: 'audience', role: 'follower', ...over })

  it('names each seat', () => {
    expect(roomChipText(meeting({ role: 'lead', seat: 'presenter' }))).toBe('Meeting AB12CD · you present · 3 here')
    expect(roomChipText(meeting())).toBe('Meeting AB12CD · watching · 3 here')
    expect(roomChipText(meeting({ seat: 'moderator' }))).toBe('Meeting AB12CD · moderating · 3 here')
  })

  it('is a lobby until a presenter arrives', () => {
    expect(roomChipText(meeting({ role: null, hasLead: false }))).toBe('Meeting AB12CD · waiting for the presenter · 3 here')
  })
})

describe('mountRoomChip', () => {
  it('follows the status and leaves nothing behind', () => {
    const root = document.createElement('div')
    let push: (s: RoomStatus) => void = () => {}
    let unsubscribed = false
    const dispose = mountRoomChip(root, (listener) => {
      push = listener
      listener(status({ connected: false, role: null }))
      return () => { unsubscribed = true }
    })
    const chip = root.querySelector<HTMLElement>('.room-chip')!
    expect(chip.dataset.role).toBe('connecting')
    push(status({ role: 'follower' }))
    expect(chip.textContent).toContain('following')
    expect(chip.dataset.role).toBe('follower')
    dispose()
    expect(unsubscribed).toBe(true)
    expect(root.children).toHaveLength(0)
  })
})
