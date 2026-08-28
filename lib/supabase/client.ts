import { createBrowserClient } from '@supabase/ssr'
import type { Database } from './database.types'
import { getPublicSupabaseConfig } from './config'

export function createClient() {
  const { publishableKey, supabaseUrl } = getPublicSupabaseConfig()
  return createBrowserClient<Database>(supabaseUrl, publishableKey)
}
