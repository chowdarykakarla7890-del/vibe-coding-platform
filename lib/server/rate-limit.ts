import 'server-only'
import { createAdminSupabaseClient } from '@/lib/supabase/server'
import { ApiError } from './api'

const policies = {
  'project-create': { limit: 10, seconds: 60 },
  'import-create': { limit: 10, seconds: 3600 },
  'import-request': { limit: 120, seconds: 60 },
  'archive-create': { limit: 3, seconds: 3600 },
  'archive-read': { limit: 300, seconds: 60 },
  'source-write': { limit: 120, seconds: 60 },
  'source-read': { limit: 120, seconds: 60 },
  'source-capture-retry': { limit: 3, seconds: 60 },
  'portfolio-write': { limit: 30, seconds: 60 },
  'sandbox-create-hour': { limit: 3, seconds: 3600 },
  'sandbox-create-day': { limit: 10, seconds: 86400 },
  'sandbox-mutation': { limit: 60, seconds: 60 },
  'sandbox-preview': { limit: 60, seconds: 60 },
  'sandbox-stop': { limit: 3, seconds: 60 },
  'ai-minute': { limit: 10, seconds: 60 },
  'ai-day': { limit: 200, seconds: 86400 },
  'assessment-minute': { limit: 10, seconds: 60 },
  'assessment-day': { limit: 200, seconds: 86400 },
} as const

export async function consumeQuota(userId: string, policy: keyof typeof policies) {
  const { limit, seconds } = policies[policy]
  const { data, error } = await createAdminSupabaseClient().rpc('consume_rate_limit', {
    p_user_id: userId, p_bucket_key: policy, p_limit: limit, p_window_seconds: seconds,
  })
  if (error) throw error
  const result = data?.[0]
  if (!result) throw new Error('Rate limit service returned no result.')
  const reset = Math.ceil(Date.parse(result.reset_at) / 1000)
  const headers = {
    'X-RateLimit-Limit': String(limit), 'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(reset),
  }
  if (!result.allowed) throw new ApiError(429, 'RATE_LIMITED', 'Too many requests. Please wait and retry.', {
    ...headers, 'Retry-After': String(Math.max(1, reset - Math.floor(Date.now() / 1000))),
  })
  return headers
}
