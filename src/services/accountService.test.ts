import { describe, expect, it, vi } from 'vitest'
import { fetchAccountState } from './accountService'

describe('fetchAccountState', () => {
  it('returns the account state JSON', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      authenticated: true,
      user: { email: 'reader@example.com', type: 'user' },
      loginAvailable: true,
    }), {
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch

    await expect(fetchAccountState(fetchImpl)).resolves.toMatchObject({
      authenticated: true,
      user: { email: 'reader@example.com' },
    })
    expect(fetchImpl).toHaveBeenCalledWith('/api/v1/account/me', expect.objectContaining({
      credentials: 'include',
    }))
  })

  it('keeps the sign-in action available when the account endpoint is blocked', async () => {
    const fetchImpl = vi.fn(async () => new Response('Forbidden', { status: 403 })) as unknown as typeof fetch

    await expect(fetchAccountState(fetchImpl)).resolves.toMatchObject({
      authenticated: false,
      loginAvailable: true,
      loginUrl: '/api/v1/account/login',
      error: 'http_403',
    })
  })
})
