import { NextResponse, type NextRequest } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { safeNextPath } from '@/lib/auth/redirect'
import { requestOrigin } from '@/lib/auth/request-origin'
import { withAuthDeadline } from '@/lib/auth/session-check'

export async function GET(request: NextRequest) {
  const origin = requestOrigin(request)
  if (!origin) return new NextResponse('Invalid request authority.', { status: 400, headers: { 'Cache-Control': 'private, no-store' } })
  const code = request.nextUrl.searchParams.get('code')
  const next = safeNextPath(request.nextUrl.searchParams.get('next'))
  let destination = '/sign-in?error=callback'
  if (next !== '/playground') destination += `&next=${encodeURIComponent(next)}`
  if (code && code.length <= 2048) {
    try {
      await withAuthDeadline(async signal => {
        const supabase = await createServerSupabaseClient(signal)
        signal.throwIfAborted()
        const { error } = await supabase.auth.exchangeCodeForSession(code)
        if (error) throw error
      }, request.signal)
      destination = next
    } catch {
      // Never put the provider response, tokens, or auth code in a URL/log.
    }
  }
  const response = NextResponse.redirect(new URL(destination, origin))
  response.headers.set('Cache-Control', 'private, no-store')
  return response
}
