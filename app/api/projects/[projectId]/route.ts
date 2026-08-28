import { apiFailure, apiJson, assertSameOrigin, parseBody, requireOwnedProject, requireUser } from '@/lib/server/api'
import { updateProjectSchema } from '@/lib/projects/schema'
import { createAdminSupabaseClient } from '@/lib/supabase/server'
import { scheduleSandboxCleanup } from '@/lib/server/sandbox-cleanup-dispatch'
import { ownedProjectsQuery } from '@/lib/server/projects'

type Context = { params: Promise<{ projectId: string }> }
export const maxDuration = 60

export async function GET(request: Request, context: Context) {
  const requestId = crypto.randomUUID()
  try {
    const auth = await requireUser(request)
    const { projectId } = await context.params
    await requireOwnedProject(projectId, auth)
    const { data, error } = await ownedProjectsQuery(auth).eq('id', projectId).single()
    if (error) throw error
    return apiJson({ project: data }, requestId)
  } catch (error) { return apiFailure(error, requestId) }
}

export async function PATCH(request: Request, context: Context) {
  const requestId = crypto.randomUUID()
  try {
    const auth = await requireUser(request)
    assertSameOrigin(request)
    const { projectId } = await context.params
    await requireOwnedProject(projectId, auth)
    const input = await parseBody(request, updateProjectSchema)
    const { error } = await auth.supabase.from('projects').update({
      title: input.title, mode: input.mode, language: input.language,
      activity_id: input.activityId, status: input.status, updated_at: new Date().toISOString(),
    }).eq('id', projectId).eq('user_id', auth.user.id).select('*').single()
    if (error) throw error
    const { data, error: readError } = await ownedProjectsQuery(auth).eq('id', projectId).single()
    if (readError) throw readError
    return apiJson({ project: data }, requestId)
  } catch (error) { return apiFailure(error, requestId) }
}

export async function DELETE(request: Request, context: Context) {
  const requestId = crypto.randomUUID()
  try {
    const auth = await requireUser(request)
    assertSameOrigin(request)
    const { projectId } = await context.params
    await requireOwnedProject(projectId, auth)
    const admin = createAdminSupabaseClient()
    const { data: sessions, error: readError } = await admin.from('sandbox_sessions').select('id').eq('project_id', projectId).eq('user_id', auth.user.id)
    if (readError) throw readError
    // Database deletion and cleanup tombstones commit atomically. A pending
    // creation has a deterministic handle even before sandbox_id is known.
    const { error } = await admin.from('projects').delete().eq('id', projectId).eq('user_id', auth.user.id)
    if (error) throw error
    scheduleSandboxCleanup(sessions.slice(0, 10).map(session => session.id))
    return apiJson({ deleted: true, sandboxCleanup: 'scheduled' }, requestId)
  } catch (error) { return apiFailure(error, requestId) }
}
