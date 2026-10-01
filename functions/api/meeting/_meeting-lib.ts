// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * AYNI — who may host a meeting, and the signed links that seat people in
 * one (`docs/SHARED_AR_PLAN.md`).
 *
 * The scheme is the desktop apps' meeting server's, on purpose, down to
 * the names: the host proves itself with `X-Meeting-Api-Key` against the
 * `MEETING_API_KEY` secret, and a link carries an `st` token of the form
 * `room.seat.expiry.signature`, signed with HMAC-SHA256 under
 * `MEETING_SIGNING_SECRET` (falling back to the API key, as there). One
 * scheme across the products means one thing to audit and to rotate.
 *
 * `mayHostMeeting` is the single place "who may host" is decided. Today
 * it is the holder of the key, which is the owner. When hosting is sold,
 * this is the function that learns to ask about an account and its plan;
 * nothing else changes.
 *
 * Fails closed: with no secret configured nobody may host and no token
 * verifies. The audience needs no token — a meeting is open to watch.
 */

import type { RoomSeat } from '../../../src/services/roomProtocol'

export interface MeetingEnv {
  /** The key a host presents. Encrypted secret. */
  MEETING_API_KEY?: string
  /** The key links are signed with. Encrypted secret; defaults to the API key. */
  MEETING_SIGNING_SECRET?: string
}

/** The seats a link can grant. The audience's link is unsigned. */
export type SignedSeat = Exclude<RoomSeat, 'audience'>

/** How long a meeting, and the links into it, last. */
export const MEETING_LIFETIME_MS = 8 * 60 * 60 * 1000

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i++) mismatch |= a[i] ^ b[i]
  return mismatch === 0
}

const utf8 = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>

/** May this request start a meeting? */
export function mayHostMeeting(request: Request, env: MeetingEnv): boolean {
  const expected = (env.MEETING_API_KEY ?? '').trim()
  if (!expected) return false
  const provided = (request.headers.get('X-Meeting-Api-Key') ?? '').trim()
  return provided.length > 0 && constantTimeEqual(utf8(provided), utf8(expected))
}

function signingSecret(env: MeetingEnv): string {
  return (env.MEETING_SIGNING_SECRET || env.MEETING_API_KEY || '').trim()
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function fromBase64Url(input: string): Uint8Array | null {
  try {
    const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((input.length + 3) % 4)
    const binary = atob(padded)
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', utf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8(message)))
}

/** A token seating its bearer in `room` as `seat` until `expiresAt`; null when nothing can sign. */
export async function createMeetingToken(
  env: MeetingEnv,
  room: string,
  seat: SignedSeat,
  expiresAt: number,
): Promise<string | null> {
  const secret = signingSecret(env)
  if (!secret) return null
  const payload = `${room}.${seat}.${expiresAt}`
  return `${payload}.${toBase64Url(await hmacSha256(secret, payload))}`
}

/**
 * The seat a token grants in `room` at `now`, or null: for a token that
 * is malformed, for another room, expired, or not signed by this site.
 */
export async function seatFromMeetingToken(
  env: MeetingEnv,
  token: string | null,
  room: string,
  now: number = Date.now(),
): Promise<SignedSeat | null> {
  const secret = signingSecret(env)
  if (!secret || !token) return null
  const parts = token.split('.')
  if (parts.length !== 4) return null
  const [tokenRoom, seat, expiry, signature] = parts
  if (tokenRoom !== room || (seat !== 'presenter' && seat !== 'moderator')) return null
  const expiresAt = Number(expiry)
  if (!Number.isFinite(expiresAt) || now > expiresAt) return null
  const provided = fromBase64Url(signature)
  if (!provided) return null
  const expected = await hmacSha256(secret, `${tokenRoom}.${seat}.${expiry}`)
  return constantTimeEqual(provided, expected) ? seat : null
}
