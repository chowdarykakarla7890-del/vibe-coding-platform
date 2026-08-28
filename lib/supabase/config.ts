const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY

export function getPublicSupabaseConfig() {
  if (!supabaseUrl || !publishableKey) {
    throw new Error('Supabase public configuration is missing.')
  }
  return { publishableKey, supabaseUrl }
}
