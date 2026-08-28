import { ApiError, apiFailure, apiJson, requireUser } from '@/lib/server/api'
import { activityManifestSchema } from '@/lib/learning/types'

export async function GET(request: Request) {
  const requestId = crypto.randomUUID()
  try {
    const auth = await requireUser(request)
    const cursor = new URL(request.url).searchParams.get('after')
    if (cursor && !/^[a-z0-9][a-z0-9-]{2,79}$/.test(cursor)) throw new ApiError(400, 'INVALID_CURSOR', 'Choose a valid activity cursor.')
    let query = auth.supabase.from('generated_activities').select('id,manifest').eq('user_id', auth.user.id).order('id').limit(21)
    if (cursor) query = query.gt('id', cursor)
    const { data, error } = await query
    if (error) throw error
    const activities = []
    let bytes = 0
    for (const row of data.slice(0, 20)) {
      const activity = activityManifestSchema.parse(row.manifest)
      const size = Buffer.byteLength(JSON.stringify(activity))
      if (activities.length && bytes + size > 2_000_000) break
      activities.push(activity)
      bytes += size
    }
    return apiJson({ activities, nextCursor: data.length > activities.length ? data[activities.length - 1].id : null }, requestId)
  } catch (error) { return apiFailure(error, requestId) }
}
