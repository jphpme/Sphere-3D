// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MeetingCreateResult } from '../services/meetingHost'
import { until } from '../test-utils'
import { closeMeetingPanel, openMeetingPanel } from './meetingPanel'

const meeting = {
  code: 'ABCDEFGH23',
  expiresAt: Date.now() + 3_600_000,
  links: {
    presenter: 'https://vr.example/?room=ABCDEFGH23&st=p',
    moderator: 'https://vr.example/?room=ABCDEFGH23&st=m',
    audience: 'https://vr.example/?room=ABCDEFGH23',
  },
}

const panel = () => document.getElementById('meeting-panel')
const button = (text: string) =>
  [...panel()!.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement | undefined

describe('openMeetingPanel', () => {
  afterEach(() => {
    closeMeetingPanel()
  })

  it('creates a meeting and shows its three links', async () => {
    const create = vi.fn(async (): Promise<MeetingCreateResult> => ({ ok: true, meeting }))
    openMeetingPanel(null, { create })
    button('Create meeting')!.click()
    await until(() => panel()!.querySelectorAll('input').length === 3, 'the links')
    const values = [...panel()!.querySelectorAll('input')].map((i) => i.value)
    expect(values).toEqual([meeting.links.audience, meeting.links.moderator, meeting.links.presenter])
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('steps into the presenter’s seat on request', async () => {
    const navigate = vi.fn()
    openMeetingPanel(null, { create: async () => ({ ok: true, meeting }), navigate })
    button('Create meeting')!.click()
    await until(() => !!button('Start presenting'), 'the present button')
    button('Start presenting')!.click()
    expect(navigate).toHaveBeenCalledWith(meeting.links.presenter)
  })

  it('says why when the meeting cannot be created, and lets the host try again', async () => {
    openMeetingPanel(null, { create: async () => ({ ok: false, reason: 'unauthorized' }) })
    const start = button('Create meeting')!
    start.click()
    await until(() => !start.disabled, 'the button to come back')
    expect(panel()!.querySelector('.meeting-panel-status')!.textContent).toBe('This browser is not allowed to host meetings.')
  })

  it('closes on Escape and hands the focus back', () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    openMeetingPanel(trigger, { create: async () => ({ ok: true, meeting }) })
    panel()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(panel()).toBeNull()
    expect(document.getElementById('meeting-backdrop')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })
})
