import { apiFailure, apiJson, assertSameOrigin, parseBody, requireUser } from '@/lib/server/api'
import { createProjectSchema } from '@/lib/projects/schema'
import { ApiError } from '@/lib/server/api'
import { z } from 'zod'
import { consumeQuota } from '@/lib/server/rate-limit'
import { ownedProjectsQuery } from '@/lib/server/projects'

export async function GET(request: Request) {
  const requestId = crypto.randomUUID()
  try {
    const auth = await requireUser(request)
    const cursor = new URL(request.url).searchParams.get('after')
    if (cursor && !z.string().uuid().safeParse(cursor).success) throw new ApiError(400, 'INVALID_CURSOR', 'The project cursor is invalid.')
    let query = ownedProjectsQuery(auth).order('id').limit(101)
    if (cursor) query = query.gt('id', cursor)
    const { data, error } = await query
    if (error) throw error
    return apiJson({ projects: data.slice(0, 100), nextCursor: data.length > 100 ? data[99].id : null }, requestId)
  } catch (error) { return apiFailure(error, requestId) }
}

export async function POST(request: Request) {
  const requestId = crypto.randomUUID()
  try {
    const { supabase, user } = await requireUser(request)
    assertSameOrigin(request)
    const input = await parseBody(request, createProjectSchema)
    const quota = await consumeQuota(user.id, 'project-create')
    const { data, error } = await supabase.from('projects').insert({
      id: input.id,
      user_id: user.id,
      title: input.title,
      mode: input.mode,
      language: input.language,
      activity_id: input.activityId,
      imported_local_id: input.importedLocalId,
    }).select('*').single()
    if (error?.code === '23505' && input.id) {
      const { data: existing, error: readError } = await supabase.from('projects').select('*').eq('id', input.id).eq('user_id', user.id).maybeSingle()
      if (readError) throw readError
      if (existing) return apiJson({ project: existing }, requestId, 200, quota)
      throw new ApiError(409, 'PROJECT_EXISTS', 'Choose a new project ID.')
    }
    if (error) throw error
    return apiJson({ project: data }, requestId, 201, quota)
  } catch (error) { return apiFailure(error, requestId) }
}
