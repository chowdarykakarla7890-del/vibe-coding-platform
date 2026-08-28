import 'server-only'
import type { AuthContext } from './api'

/** RLS plus an explicit owner filter; only the most recent registered sandbox. */
export function ownedProjectsQuery(auth: AuthContext) {
  return auth.supabase.from('projects')
    .select('*, sandbox_sessions(sandbox_id,status,expires_at,preview_origin)')
    .eq('user_id', auth.user.id)
    .not('sandbox_sessions.sandbox_id', 'is', null)
    .order('created_at', { referencedTable: 'sandbox_sessions', ascending: false })
    .order('id', { referencedTable: 'sandbox_sessions', ascending: false })
    .limit(1, { referencedTable: 'sandbox_sessions' })
}
