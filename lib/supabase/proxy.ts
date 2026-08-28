import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import type { Database } from './database.types'
import { getPublicSupabaseConfig } from './config'
import { requestOrigin } from '@/lib/auth/request-origin'
import { safeNextPath } from '@/lib/auth/redirect'
import { authFetch, AuthRequestInterruptedError, AUTH_UNAVAILABLE_MESSAGE, hasVerifiedClaims, verifiedUser, withAuthDeadline } from '@/lib/auth/session-check'

const AUTH_HANDLERS = new Set(['/auth/callback', '/auth/sign-out'])
// Must match withBotId's SDK-owned rewrite prefix (botid/next/config).
// Challenge assets/proxy requests must load before the user has signed in.
const BOTID_PREFIX = '/149e9513-01fa-4fb0-aad4-566afd725d1b/2d206a39-8ed7-437e-a3be-862e0f06eea3'

export async function updateSession(request: NextRequest) {
  const origin = requestOrigin(request)
  if (!origin) return new NextResponse('Invalid request authority.', { status: 400, headers: { 'Cache-Control': 'private, no-store' } })
  let response = NextResponse.next({ request })
  if (request.nextUrl.pathname === BOTID_PREFIX || request.nextUrl.pathname.startsWith(`${BOTID_PREFIX}/`)) {
    return response
  }
  function finish(next: NextResponse) {
    response.cookies.getAll().forEach((cookie) => next.cookies.set(cookie))
    next.headers.set('Cache-Control', 'private, no-store')
    return next
  }
  // Code exchange and CSRF-protected sign-out own their checks. A stale old
  // session must not block a fresh exchange or redirect a POST into sign-in.
  if (AUTH_HANDLERS.has(request.nextUrl.pathname)) return finish(response)

  const isSignIn = request.nextUrl.pathname === '/sign-in'
  let signedIn: boolean
  let acceptCookies = true
  try {
    signedIn = await withAuthDeadline(async signal => {
      const { publishableKey, supabaseUrl } = getPublicSupabaseConfig()
      const supabase = createServerClient<Database>(supabaseUrl, publishableKey, {
        global: { fetch: authFetch(signal) },
        cookies: {
          getAll: () => request.cookies.getAll(),
          setAll(cookiesToSet, headers) {
            if (!acceptCookies || signal.aborted) return
            const previous = response.cookies.getAll()
            cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
            response = NextResponse.next({ request })
            previous.forEach(cookie => response.cookies.set(cookie))
            cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options))
            Object.entries(headers).forEach(([name, value]) => response.headers.set(name, value))
          },
        },
      })
      // Cached claims can route toward a workspace whose live user check is
      // denied. Use the same authoritative check for the return from sign-in
      // to avoid bouncing between these two routes.
      return isSignIn ? Boolean(await verifiedUser(supabase)) : hasVerifiedClaims(supabase)
    }, request.signal)
  } catch (error) {
    const interrupted = error instanceof AuthRequestInterruptedError
    const requestId = crypto.randomUUID()
    const code = interrupted ? 'AUTH_INTERRUPTED' : 'AUTH_UNAVAILABLE'
    const message = interrupted ? 'The authentication request was interrupted. Please retry.' : AUTH_UNAVAILABLE_MESSAGE
    const headers = { 'X-Request-Id': requestId, ...(!interrupted ? { 'Retry-After': '5' } : {}) }
    if (!interrupted) console.warn('Authentication check unavailable', { requestId, code, context: 'proxy' })
    if (request.method !== 'GET' || interrupted) {
      return finish(NextResponse.json({ error: { code, message, requestId } }, { status: interrupted ? 408 : 503, headers }))
    }
    // Static content only: never interpolate the request URL, auth code, or a
    // provider error. A normal link retries this GET without clearing cookies.
    return finish(new NextResponse(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>CodeTutor · Connection unavailable</title></head><body style="background:#0f1012;color:#f4f4f5;font-family:system-ui;display:grid;min-height:95vh;place-items:center"><main style="max-width:440px;padding:24px"><h1>Unable to verify your session</h1><p>${AUTH_UNAVAILABLE_MESSAGE}</p><a href="" style="color:inherit">Try again</a></main></body></html>`, {
      status: 503, headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
    }))
  } finally {
    acceptCookies = false
  }

  if (!signedIn && !isSignIn) {
    const url = new URL('/sign-in', origin)
    const destination = `${request.nextUrl.pathname}${request.nextUrl.search}`
    if (destination.startsWith('/') && !destination.startsWith('//')) url.searchParams.set('next', destination)
    return finish(NextResponse.redirect(url))
  }
  if (signedIn && isSignIn) {
    return finish(NextResponse.redirect(new URL(safeNextPath(request.nextUrl.searchParams.get('next')), origin)))
  }
  return finish(response)
}
