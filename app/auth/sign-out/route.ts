import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { ApiError, apiFailure, apiJson, assertSameOrigin } from '@/lib/server/api'
import { requestOrigin } from '@/lib/auth/request-origin'
import { verifiedUser, withAuthDeadline } from '@/lib/auth/session-check'
import { z } from 'zod'

export async function POST(request: Request) {
  const requestId = crypto.randomUUID()
  try {
    assertSameOrigin(request)
    const wantsJson = request.headers.get('accept')?.split(',').some(value => value.trim().split(';')[0].toLowerCase() === 'application/json')
    const expectedAccount = request.headers.get('X-CodeTutor-Account')
    if ((wantsJson || expectedAccount !== null) && !z.string().uuid().safeParse(expectedAccount).success) {
      throw new ApiError(400, 'INVALID_ACCOUNT', 'Reopen your workspace before signing out.')
    }
    const accountChanged = await withAuthDeadline(async signal => {
      const supabase = await createServerSupabaseClient(signal)
      signal.throwIfAborted()
      if (expectedAccount) {
        const user = await verifiedUser(supabase)
        signal.throwIfAborted()
        // A stale tab must not log out an account that signed in elsewhere.
        // A missing session is an idempotent retry, not a different account.
        if (user && user.id !== expectedAccount) return true
      }
      const { error } = await supabase.auth.signOut({ scope: 'local' })
      if (error) throw error
      return false
    }, request.signal)
    // Keep a deliberate identity conflict distinct from an Auth outage.
    if (accountChanged) throw new ApiError(409, 'ACCOUNT_CHANGED', 'The signed-in account changed. Reload before continuing.')
    if (wantsJson) return apiJson({ signedOut: true }, requestId)
    return NextResponse.redirect(new URL('/sign-in', requestOrigin(request)!), { status: 303, headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) { return apiFailure(error, requestId) }
}
