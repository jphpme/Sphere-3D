import type { CatalogEnv } from '../_lib/env'
import { verifyAccessJwt } from '../_lib/access-auth'
import { isLoopbackHost } from '../_lib/loopback'

const CONTENT_TYPE = 'application/json; charset=utf-8'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
  })
}

function loginUrl(request: Request): string {
  const url = new URL(request.url)
  return `/api/v1/account/login?return_to=${encodeURIComponent(url.origin + '/')}`
}

export const onRequestGet: PagesFunction<CatalogEnv> = async context => {
  const devBypass = context.env.DEV_BYPASS_ACCESS === 'true'
  if (devBypass) {
    const url = new URL(context.request.url)
    if (!isLoopbackHost(url.hostname)) {
      return json({
        authenticated: false,
        loginAvailable: false,
        error: 'dev_bypass_unsafe',
      }, 500)
    }
    const email = context.env.DEV_PUBLISHER_EMAIL ?? 'dev@localhost'
    return json({
      authenticated: true,
      user: { email, name: email, type: 'user' },
      loginAvailable: false,
      logoutUrl: '/api/v1/logout',
    })
  }

  const accessConfigured = !!(context.env.ACCESS_TEAM_DOMAIN && context.env.ACCESS_AUD)
  if (!accessConfigured) {
    return json({
      authenticated: false,
      loginAvailable: false,
      error: 'access_unconfigured',
    })
  }

  const token = context.request.headers.get('Cf-Access-Jwt-Assertion')
  if (!token) {
    return json({
      authenticated: false,
      loginAvailable: true,
      loginUrl: loginUrl(context.request),
    })
  }

  const identity = await verifyAccessJwt(token, context.env)
  if (!identity) {
    return json({
      authenticated: false,
      loginAvailable: true,
      loginUrl: loginUrl(context.request),
      error: 'invalid_session',
    })
  }

  return json({
    authenticated: true,
    user: {
      email: identity.email,
      name: identity.email,
      type: identity.type,
    },
    loginAvailable: true,
    logoutUrl: '/api/v1/logout',
  })
}
