import { ApiError, apiFailure, apiJson, requireUser } from '@/lib/server/api'

export async function GET(request: Request) {
  const requestId = crypto.randomUUID()
  try {
    const auth = await requireUser(request)
    const cursor = new URL(request.url).searchParams.get('after')
    if (cursor && !/^[a-z0-9][a-z0-9-]{2,127}$/.test(cursor)) throw new ApiError(400, 'INVALID_CURSOR', 'Choose a valid progress cursor.')
    let query = auth.supabase.from('assessment_progress').select('*').eq('user_id', auth.user.id).order('activity_id').limit(101)
    if (cursor) query = query.gt('activity_id', cursor)
    const { data, error } = await query
    if (error) throw error
    return apiJson({ progress: data.slice(0, 100).map((row) => ({
      activityId: row.activity_id, attempts: row.attempts, completed: row.completed,
      bestScore: row.best_score, concepts: row.concepts, updatedAt: Date.parse(row.updated_at!),
    })), nextCursor: data.length > 100 ? data[99].activity_id : null }, requestId)
  } catch (error) { return apiFailure(error, requestId) }
}
