import { ApiError, apiFailure, apiJson, assertSameOrigin, parseBody, requireUser } from '@/lib/server/api'
import { portfolioDocumentSchema } from '@/lib/learning/types'
import { consumeQuota } from '@/lib/server/rate-limit'

export async function GET(request: Request) {
  const requestId = crypto.randomUUID()
  try {
    const { supabase, user } = await requireUser(request)
    const { data, error } = await supabase.from('portfolios').select('document').eq('user_id', user.id).maybeSingle()
    if (error) throw error
    return apiJson({ portfolio: data?.document ?? null }, requestId)
  } catch (error) { return apiFailure(error, requestId) }
}

export async function PUT(request: Request) {
  const requestId = crypto.randomUUID()
  try {
    const { supabase, user } = await requireUser(request)
    assertSameOrigin(request)
    const document = await parseBody(request, portfolioDocumentSchema, 2 * 1024 * 1024)
    const quota = await consumeQuota(user.id, 'portfolio-write')
    const { error } = await supabase.from('portfolios').upsert({ user_id: user.id, document, updated_at: new Date().toISOString() })
    if (error?.code === '23514') throw new ApiError(413, 'PORTFOLIO_LIMIT', 'Keep the portfolio under 2 MB. Reduce the number or size of screenshots.')
    if (error) throw error
    return apiJson({ saved: true }, requestId, 200, quota)
  } catch (error) { return apiFailure(error, requestId) }
}
