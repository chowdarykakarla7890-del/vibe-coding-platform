import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import type { Database } from './database.types'
import { getPublicSupabaseConfig } from './config'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { authFetch } from '@/lib/auth/session-check'

export async function createServerSupabaseClient(signal?: AbortSignal) {
  signal?.throwIfAborted()
  const cookieStore = await cookies()
  signal?.throwIfAborted()
  const { publishableKey, supabaseUrl } = getPublicSupabaseConfig()
  return createServerClient<Database>(supabaseUrl, publishableKey, {
    ...(signal ? { global: { fetch: authFetch(signal) } } : {}),
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll(cookiesToSet) {
        // A refresh/exchange may finish after its caller has timed out. Never
        // mutate a response that has already settled or a cancelled request.
        if (signal?.aborted) return
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options))
        } catch {
          // Server Components cannot write cookies; proxy.ts refreshes them.
        }
      },
    },
  })
}

export function createAdminSupabaseClient() {
  const { supabaseUrl } = getPublicSupabaseConfig()
  const secretKey = process.env.SUPABASE_SECRET_KEY
  if (!secretKey) throw new Error('Supabase server configuration is missing.')
  return createSupabaseClient<Database>(supabaseUrl, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}
import 'server-only'
