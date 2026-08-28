import { z } from 'zod'
import { ApiError, apiFailure, apiJson, assertSameOrigin, parseBody, requireOwnedProject, requireUser } from '@/lib/server/api'
import { consumeQuota } from '@/lib/server/rate-limit'
import { retryOwnedSourceCaptures } from '@/lib/server/source-recovery'

type Context = { params: Promise<{ projectId: string }> }
export async function GET(request: Request, context: Context) {
  const requestId = crypto.randomUUID()
  try {
    const auth = await requireUser(request)
    const { projectId } = await context.params
    await requireOwnedProject(projectId, auth)
    const query = new URL(request.url).searchParams
    const after = query.get('after'), history = query.get('history')
    if ((after && !z.string().uuid().safeParse(after).success) || (history !== null && history !== '1')) throw new ApiError(400, 'INVALID_CURSOR', 'Choose a valid source-review page.')
    const quota = await consumeQuota(auth.user.id, 'source-read')
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)])
    const latest = await auth.supabase.from('sandbox_sessions').select('created_at').eq('project_id', projectId).eq('user_id', auth.user.id)
      .order('created_at', { ascending: false }).limit(1).abortSignal(signal).maybeSingle()
    if (latest.error) throw new ApiError(502, 'SOURCE_REVIEW_UNAVAILABLE', 'Source recovery status could not be loaded. Retry to check your saved work.')
    let page = auth.supabase.from('source_capture_conflicts').select('id,path,reason,created_at,resolved_at')
      .eq('project_id', projectId).eq('user_id', auth.user.id).order('id').limit(20)
    page = history === '1' ? page.not('resolved_at', 'is', null) : page.is('resolved_at', null)
    if (after) page = page.gt('id', after)
    const jobs = (states: string[]) => auth.supabase.from('source_capture_jobs').select('id', { count: 'exact', head: true })
      .eq('project_id', projectId).eq('user_id', auth.user.id).in('state', states).abortSignal(signal)
    const [items, pending, incomplete, expired, unresolved, savedOnly, paused] = await Promise.all([
      page.abortSignal(signal), jobs(['queued', 'capturing', 'acknowledging']), jobs(['incomplete']), jobs(['expired']),
      auth.supabase.from('source_capture_conflicts').select('id', { count: 'exact', head: true })
        .eq('project_id', projectId).eq('user_id', auth.user.id).is('resolved_at', null).abortSignal(signal),
      latest.data ? auth.supabase.from('source_capture_conflicts').select('id', { count: 'exact', head: true })
        .eq('project_id', projectId).eq('user_id', auth.user.id).gt('resolved_at', latest.data.created_at).abortSignal(signal)
        : Promise.resolve({ count: 0, error: null }),
      auth.supabase.from('source_capture_jobs').select('id', { count: 'exact', head: true })
        .eq('project_id', projectId).eq('user_id', auth.user.id).eq('state', 'incomplete').not('retry_state', 'is', null).abortSignal(signal),
    ])
    if ([items, pending, incomplete, expired, unresolved, savedOnly, paused].some((result) => result.error)) throw new ApiError(502, 'SOURCE_REVIEW_UNAVAILABLE', 'Source recovery status could not be loaded. Retry to check your saved work.')
    return apiJson({ conflicts: items.data!.map((item) => ({ id: item.id, path: item.path, reason: item.reason, createdAt: item.created_at, resolvedAt: item.resolved_at })),
      nextCursor: items.data!.length === 20 ? items.data!.at(-1)!.id : null,
      pending: pending.count ?? 0, incomplete: incomplete.count ?? 0, expired: expired.count ?? 0, unresolved: unresolved.count ?? 0, savedOnly: savedOnly.count ?? 0, paused: paused.count ?? 0 }, requestId, 200, quota)
  } catch (error) { return apiFailure(error, requestId) }
}

export async function POST(request: Request, context: Context) {
  const requestId = crypto.randomUUID()
  try {
    const auth = await requireUser(request)
    assertSameOrigin(request)
    const { projectId } = await context.params
    await requireOwnedProject(projectId, auth)
    await parseBody(request, z.object({ action: z.literal('retry') }).strict(), 1024)
    const quota = await consumeQuota(auth.user.id, 'source-capture-retry')
    const resumed = await retryOwnedSourceCaptures(auth, projectId)
    return apiJson({ resumed }, requestId, 200, quota)
  } catch (error) { return apiFailure(error, requestId) }
}
