// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * AYNI — the host's side of a meeting (`docs/SHARED_AR_PLAN.md`): the key
 * that lets this browser start one, and the call that does.
 *
 * Hosting is not public. A browser may host once it has been opened with
 * `?meetingKey=<key>`; the key is kept in this browser's storage and
 * taken out of the address bar, and `?meetingKey=off` forgets it. Without
 * a key there is no "Start a meeting" entry at all (the Tools menu asks
 * `hasMeetingKey`), the same shape as the geo-media switch. The key only
 * opens the door on this side: the server checks it on every request
 * (`functions/api/meeting`), so a wrong key shows the entry and is then
 * refused.
 *
 * When hosting is sold, the key gives way to an account and its plan; the
 * panel and `createMeeting`'s result stay as they are.
 */

const STORAGE_KEY = 'ayni-meeting-key'
const PARAM = 'meetingKey'

export interface MeetingLinks {
  /** The room code, for saying aloud. */
  code: string
  /** When the meeting and its links stop working, epoch ms. */
  expiresAt: number
  links: { presenter: string; moderator: string; audience: string }
}

export type MeetingCreateResult =
  | { ok: true; meeting: MeetingLinks }
  /** `unauthorized`: the key was refused. `unavailable`: meetings are not set up or the request failed. */
  | { ok: false; reason: 'unauthorized' | 'unavailable' }

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/**
 * Take a `?meetingKey=` from a page address: store the key (or forget it
 * for `off`) and return the address without the parameter, or null when
 * there was none.
 */
export function takeMeetingKeyParam(href: string, store: Storage | null = storage()): string | null {
  const url = new URL(href)
  const value = url.searchParams.get(PARAM)
  if (value === null) return null
  const key = value.trim()
  try {
    if (!key || key === 'off') store?.removeItem(STORAGE_KEY)
    else store?.setItem(STORAGE_KEY, key)
  } catch {
    // Storage refused (private mode): the key lasts as long as nothing.
  }
  url.searchParams.delete(PARAM)
  return url.toString()
}

/** The stored host key, or null. */
export function meetingKey(store: Storage | null = storage()): string | null {
  try {
    const key = store?.getItem(STORAGE_KEY)?.trim()
    return key ? key : null
  } catch {
    return null
  }
}

/** Whether this browser has been given a host key. */
export function hasMeetingKey(): boolean {
  return meetingKey() !== null
}

/** Ask the site for a new meeting. */
export async function createMeeting(
  key: string | null = meetingKey(),
  fetchImpl: typeof fetch = fetch,
): Promise<MeetingCreateResult> {
  if (!key) return { ok: false, reason: 'unauthorized' }
  try {
    const res = await fetchImpl('/api/meeting', { method: 'POST', headers: { 'X-Meeting-Api-Key': key } })
    if (res.status === 401) return { ok: false, reason: 'unauthorized' }
    if (!res.ok) return { ok: false, reason: 'unavailable' }
    const body = (await res.json()) as Partial<MeetingLinks>
    const links = body.links
    if (
      typeof body.code !== 'string' ||
      typeof body.expiresAt !== 'number' ||
      !links ||
      typeof links.presenter !== 'string' ||
      typeof links.moderator !== 'string' ||
      typeof links.audience !== 'string'
    ) {
      return { ok: false, reason: 'unavailable' }
    }
    return { ok: true, meeting: { code: body.code, expiresAt: body.expiresAt, links } }
  } catch {
    return { ok: false, reason: 'unavailable' }
  }
}
