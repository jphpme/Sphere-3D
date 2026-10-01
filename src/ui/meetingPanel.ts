// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * AYNI — Tools → Start a meeting (`docs/SHARED_AR_PLAN.md`): creates a
 * meeting and hands the host its three links — the presenter's, the
 * moderator's and the audience's — each with a copy button, and a way to
 * step straight into the presenter's seat.
 *
 * Shown only on a browser that holds a host key (`meetingHost.ts`); the
 * Tools menu does not render the entry otherwise. The links are shown
 * once: the signed ones are the only proof of the seat they grant, and
 * the site keeps no list of meetings to read them back from.
 */

import { t, type MessageKey } from '../i18n'
import { createMeeting, type MeetingLinks } from '../services/meetingHost'

let closeOpenPanel: (() => void) | null = null

/** Close the panel if it is open. */
export function closeMeetingPanel(): void {
  closeOpenPanel?.()
}

interface MeetingPanelOptions {
  /** Create the meeting; injectable for tests. */
  create?: typeof createMeeting
  /** Go to an address; injectable for tests. */
  navigate?: (url: string) => void
}

/** Open the panel. `trigger` gets the focus back when it closes. */
export function openMeetingPanel(trigger?: HTMLElement | null, opts: MeetingPanelOptions = {}): void {
  if (closeOpenPanel) return
  const create = opts.create ?? createMeeting
  const navigate = opts.navigate ?? ((url: string) => { window.location.assign(url) })

  const backdrop = document.createElement('div')
  backdrop.id = 'meeting-backdrop'
  const panel = document.createElement('div')
  panel.id = 'meeting-panel'
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', 'true')
  panel.setAttribute('aria-labelledby', 'meeting-panel-title')

  const header = document.createElement('div')
  header.className = 'meeting-panel-header'
  const title = document.createElement('h2')
  title.id = 'meeting-panel-title'
  title.textContent = t('meeting.panel.title')
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'meeting-panel-close'
  close.setAttribute('aria-label', t('meeting.panel.close.aria'))
  close.textContent = '✕'
  header.append(title, close)

  const body = document.createElement('div')
  body.className = 'meeting-panel-body'
  const intro = document.createElement('p')
  intro.textContent = t('meeting.panel.intro')
  const start = document.createElement('button')
  start.type = 'button'
  start.className = 'meeting-panel-primary'
  start.textContent = t('meeting.panel.create')
  const status = document.createElement('p')
  status.className = 'meeting-panel-status'
  status.setAttribute('role', 'status')
  body.append(intro, start, status)

  panel.append(header, body)
  document.body.append(backdrop, panel)

  function linkRow(labelKey: MessageKey, url: string): HTMLElement {
    const row = document.createElement('div')
    row.className = 'meeting-panel-row'
    const label = document.createElement('label')
    label.textContent = t(labelKey)
    const input = document.createElement('input')
    input.type = 'text'
    input.readOnly = true
    input.value = url
    input.id = `meeting-link-${labelKey.split('.').pop()}`
    label.htmlFor = input.id
    input.addEventListener('focus', () => input.select())
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.textContent = t('meeting.panel.copy')
    copy.addEventListener('click', () => {
      const done = (): void => {
        copy.textContent = t('meeting.panel.copied')
        status.textContent = t('meeting.panel.copied')
      }
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(url).then(done, () => { input.select() })
      } else {
        // No clipboard here: leave the link selected for a manual copy.
        input.select()
      }
    })
    row.append(label, input, copy)
    return row
  }

  function showLinks(meeting: MeetingLinks): void {
    const open = document.createElement('button')
    open.type = 'button'
    open.className = 'meeting-panel-primary'
    open.textContent = t('meeting.panel.present')
    open.addEventListener('click', () => navigate(meeting.links.presenter))
    const note = document.createElement('p')
    note.className = 'meeting-panel-note'
    note.textContent = t('meeting.panel.note', {
      time: new Date(meeting.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    })
    status.textContent = ''
    body.replaceChildren(
      linkRow('meeting.panel.link.audience', meeting.links.audience),
      linkRow('meeting.panel.link.moderator', meeting.links.moderator),
      linkRow('meeting.panel.link.presenter', meeting.links.presenter),
      note,
      open,
      status,
    )
    open.focus()
  }

  start.addEventListener('click', () => {
    start.disabled = true
    status.textContent = t('meeting.panel.creating')
    void create().then((result) => {
      if (closed) return
      if (result.ok) {
        showLinks(result.meeting)
      } else {
        start.disabled = false
        status.textContent = t(
          result.reason === 'unauthorized' ? 'meeting.panel.error.unauthorized' : 'meeting.panel.error.unavailable',
        )
      }
    })
  })

  let closed = false
  function doClose(): void {
    if (closed) return
    closed = true
    closeOpenPanel = null
    panel.remove()
    backdrop.remove()
    trigger?.focus()
  }
  close.addEventListener('click', doClose)
  backdrop.addEventListener('click', doClose)
  panel.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault()
      doClose()
    }
  })
  closeOpenPanel = doClose
  start.focus()
}
