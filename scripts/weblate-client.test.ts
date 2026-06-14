import { describe, expect, it } from 'vitest'

import { retryAfterMs } from './weblate-client'

describe('weblate-client', () => {
  describe('retryAfterMs', () => {
    it('parses a delay-seconds value', () => {
      expect(retryAfterMs('30')).toBe(30_000)
      expect(retryAfterMs('0')).toBe(0)
    })

    it('parses an HTTP-date value relative to now', () => {
      const now = Date.parse('2026-06-14T06:00:00Z')
      expect(retryAfterMs('Sun, 14 Jun 2026 06:00:10 GMT', now)).toBe(10_000)
    })

    it('clamps a past date to zero', () => {
      const now = Date.parse('2026-06-14T06:00:00Z')
      expect(retryAfterMs('Sun, 14 Jun 2026 05:59:00 GMT', now)).toBe(0)
    })

    it('returns null when absent or unparseable', () => {
      expect(retryAfterMs(null)).toBeNull()
      expect(retryAfterMs('soon')).toBeNull()
    })
  })
})
