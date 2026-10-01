// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * AYNI — the one line that says this device is in a shared session, and
 * as what: leading it, following it, or still connecting
 * (`docs/SHARED_AR_PLAN.md`). With the number of people in the room,
 * because "is anyone else here?" is the first question either side has.
 *
 * Mounted into the WebXR overlay root, which is on screen both in the
 * ordinary page and over the camera picture in handheld AR, so the same
 * element serves both. It takes no input.
 */

import { t } from '../i18n'
import type { RoomStatus } from '../services/roomClient'

/** The chip's wording for a status. */
export function roomChipText(status: RoomStatus): string {
  const params = { code: status.code, count: status.count }
  if (!status.connected) return t('room.chip.connecting', params)
  if (status.meeting) {
    // A meeting with nobody presenting is a lobby: say so, to every seat.
    if (!status.hasLead) return t('meeting.chip.waiting', params)
    if (status.role === 'lead') return t('meeting.chip.presenter', params)
    return t(status.seat === 'moderator' ? 'meeting.chip.moderator' : 'meeting.chip.audience', params)
  }
  if (status.role === null) return t('room.chip.connecting', params)
  return t(status.role === 'lead' ? 'room.chip.lead' : 'room.chip.follower', params)
}

/**
 * Mount the chip under `root` and keep it current from `subscribe`
 * (`RoomSyncHandle.onStatus`). Returns its teardown.
 */
export function mountRoomChip(
  root: HTMLElement,
  subscribe: (listener: (status: RoomStatus) => void) => () => void,
): () => void {
  const chip = document.createElement('div')
  chip.className = 'room-chip'
  chip.setAttribute('role', 'status')
  root.appendChild(chip)
  const unsubscribe = subscribe((status) => {
    chip.textContent = roomChipText(status)
    chip.dataset.role = status.connected && status.role ? status.role : 'connecting'
  })
  return () => {
    unsubscribe()
    chip.remove()
  }
}
