import type { CatalogEnv } from '../_lib/env'

function sanitizeTeamDomain(raw: string | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.replace(/^https?:\/\//, '').replace(/\/+$/, '')
  return /^[a-z0-9.-]+$/i.test(trimmed) ? trimmed : null
}

function sameOriginReturnTo(request: Request): string {
  const url = new URL(request.url)
  const requested = url.searchParams.get('return_to')
  if (!requested) return `${url.origin}/`
  try {
    const target = new URL(requested, url.origin)
    if (target.origin !== url.origin) return `${url.origin}/`
    return target.toString()
  } catch {
    return `${url.origin}/`
  }
}

function loginTarget(env: CatalogEnv, returnTo: string): string | null {
  const configured = env.ACCOUNT_LOGIN_URL?.trim()
  if (configured) {
    if (configured.includes('{return_to}')) {
      return configured.replace('{return_to}', encodeURIComponent(returnTo))
    }
    try {
      const target = new URL(configured)
      target.searchParams.set('redirect_url', returnTo)
      return target.toString()
    } catch {
      return null
    }
  }

  const team = sanitizeTeamDomain(env.ACCESS_TEAM_DOMAIN)
  const aud = env.ACCESS_AUD?.trim()
  if (!team || !aud) return null
  return `https://${team}/cdn-cgi/access/login/${encodeURIComponent(aud)}?redirect_url=${encodeURIComponent(returnTo)}`
}

export const onRequestGet: PagesFunction<CatalogEnv> = async context => {
  const returnTo = sameOriginReturnTo(context.request)
  const target = loginTarget(context.env, returnTo)
  if (!target) {
    return new Response(
      JSON.stringify({
        error: 'access_unconfigured',
        message: 'Account login is not configured. Set ACCESS_TEAM_DOMAIN + ACCESS_AUD or ACCOUNT_LOGIN_URL.',
      }),
      {
        status: 503,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      },
    )
  }
  return new Response(null, {
    status: 302,
    headers: { Location: target, 'Cache-Control': 'no-store' },
  })
}

export { loginTarget, sameOriginReturnTo, sanitizeTeamDomain }
