import 'server-only'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { verifiedUser, withAuthDeadline } from './session-check'

export function readAuthenticatedUser(callerSignal?: AbortSignal) {
  return withAuthDeadline(async signal => {
    const supabase = await createServerSupabaseClient(signal)
    signal.throwIfAborted()
    const user = await verifiedUser(supabase)
    return { supabase, user }
  }, callerSignal)
}
