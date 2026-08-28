import { z } from 'zod'
import { ApiError, apiFailure, apiJson, requireOwnedProject, requireUser } from '@/lib/server/api'
import { consumeQuota } from '@/lib/server/rate-limit'
import { visibleSubmissionState } from '@/lib/learning/submissions'

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const requestId = crypto.randomUUID()
  try {
    const auth = await requireUser(request)
    const { projectId } = await params
    await requireOwnedProject(projectId, auth)
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)])
    const after = new URL(request.url).searchParams.get('after')
    if (after !== null && !z.string().uuid().safeParse(after).success) throw new ApiError(400, 'INVALID_CURSOR', 'Choose a valid submission page.')
    const quota = await consumeQuota(auth.user.id, 'source-read')
    let page = auth.supabase.from('activity_submissions').select('id,created_at,state,expires_at,failure_code,language,model_id')
      .eq('project_id', projectId).eq('user_id', auth.user.id).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(21)
    if (after) {
      const cursor = await auth.supabase.from('activity_submissions').select('created_at').eq('id', after)
        .eq('project_id', projectId).eq('user_id', auth.user.id).abortSignal(signal).maybeSingle()
      if (cursor.error) throw cursor.error
      if (!cursor.data) throw new ApiError(400, 'INVALID_CURSOR', 'The submission page is unavailable. Open the first page.')
      page = page.or(`created_at.lt.${cursor.data.created_at},and(created_at.eq.${cursor.data.created_at},id.lt.${after})`)
    }
    const { data, error } = await page.abortSignal(signal)
    if (error) throw error
    const items = data.slice(0, 20)
    const results = items.length ? await auth.supabase.from('assessments').select('submission_id,score,passed,source_current,ai_assessed')
      .eq('project_id', projectId).eq('user_id', auth.user.id).in('submission_id', items.map((item) => item.id)).abortSignal(signal) : { data: [], error: null }
    if (results.error) throw results.error
    const scores = new Map(results.data.map((result) => [result.submission_id, result]))
    return apiJson({ submissions: items.map((item) => ({ id: item.id, createdAt: item.created_at,
      state: visibleSubmissionState(item.state as 'pending' | 'complete' | 'failed', item.expires_at), failureCode: item.failure_code,
      language: item.language, modelId: item.model_id, score: scores.get(item.id)?.score ?? null,
      passed: scores.get(item.id)?.passed ?? null, sourceCurrentAtAssessment: scores.get(item.id)?.source_current ?? null,
      aiAssessed: scores.get(item.id)?.ai_assessed ?? null,
    })), nextCursor: data.length > 20 ? items.at(-1)!.id : null }, requestId, 200, quota)
  } catch (error) { return apiFailure(error, requestId) }
}
