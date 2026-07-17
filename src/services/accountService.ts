export interface AccountUser {
  email: string
  name?: string
  type?: 'user' | 'service'
}

export interface AccountState {
  authenticated: boolean
  user?: AccountUser
  loginAvailable?: boolean
  loginUrl?: string
  logoutUrl?: string
  error?: string
}

export async function fetchAccountState(fetchImpl: typeof fetch = fetch): Promise<AccountState> {
  const res = await fetchImpl('/api/v1/account/me', {
    headers: { Accept: 'application/json' },
    credentials: 'include',
  })
  if (!res.ok) {
    return {
      authenticated: false,
      loginAvailable: true,
      loginUrl: '/api/v1/account/login',
      error: `http_${res.status}`,
    }
  }
  return (await res.json()) as AccountState
}
