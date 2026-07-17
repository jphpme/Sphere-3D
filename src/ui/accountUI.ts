import { fetchAccountState, type AccountState } from '../services/accountService'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function initials(value: string): string {
  const clean = value.trim()
  if (!clean) return '?'
  const nameParts = clean.split(/\s+/).filter(Boolean)
  if (nameParts.length > 1) return (nameParts[0][0] + nameParts[1][0]).toUpperCase()
  const emailName = clean.split('@')[0] || clean
  return emailName.slice(0, 2).toUpperCase()
}

function accountLabel(state: AccountState): string {
  if (state.authenticated && state.user) {
    return state.user.name || state.user.email
  }
  if (state.loginAvailable) return 'Sign in'
  return 'Account'
}

function render(container: HTMLElement, state: AccountState): void {
  const signedIn = state.authenticated && state.user
  const label = accountLabel(state)
  const avatar = signedIn ? initials(label) : 'A'
  const body = signedIn
    ? state.user!.email
    : state.loginAvailable
      ? 'Sign in to track realtime access across devices.'
      : 'Account login is not configured yet.'
  const action = signedIn
    ? `<a class="account-action" href="${escapeHtml(state.logoutUrl ?? '/api/v1/logout')}">Sign out</a>`
    : state.loginAvailable
      ? `<a class="account-action account-action-primary" href="${escapeHtml(state.loginUrl ?? '/api/v1/account/login')}">Sign in</a>`
      : `<button class="account-action" type="button" disabled>Unavailable</button>`

  container.innerHTML = `
    <button id="account-menu-button" class="account-button" type="button" aria-expanded="false" aria-haspopup="true">
      <span class="account-avatar" aria-hidden="true">${escapeHtml(avatar)}</span>
      <span class="account-label">${escapeHtml(label)}</span>
    </button>
    <div id="account-menu-popover" class="account-popover hidden" role="dialog" aria-label="Account">
      <div class="account-popover-title">${signedIn ? 'Signed in' : 'Account'}</div>
      <div class="account-popover-body">${escapeHtml(body)}</div>
      <div class="account-popover-actions">${action}</div>
    </div>
  `

  const button = container.querySelector<HTMLButtonElement>('#account-menu-button')
  const popover = container.querySelector<HTMLElement>('#account-menu-popover')
  if (!button || !popover) return
  button.addEventListener('click', () => {
    const open = popover.classList.toggle('hidden') === false
    button.setAttribute('aria-expanded', open ? 'true' : 'false')
  })
  document.addEventListener('click', event => {
    if (container.contains(event.target as Node)) return
    popover.classList.add('hidden')
    button.setAttribute('aria-expanded', 'false')
  })
}

export async function initAccountUI(): Promise<void> {
  const container = document.getElementById('account-control')
  if (!container) return
  container.classList.remove('hidden')
  render(container, { authenticated: false, loginAvailable: false })
  try {
    render(container, await fetchAccountState())
  } catch {
    render(container, {
      authenticated: false,
      loginAvailable: true,
      loginUrl: '/api/v1/account/login',
      error: 'fetch_failed',
    })
  }
}
