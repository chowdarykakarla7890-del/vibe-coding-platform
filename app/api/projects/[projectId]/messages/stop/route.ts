import { z } from 'zod'
import { apiFailure, apiJson, assertSameOrigin, parseBody, requireOwnedProject, requireUser } from '@/lib/server/api'
import { createAdminSupabaseClient } from '@/lib/supabase/server'

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const requestId = crypto.randomUUID()
  try {
    const auth = await requireUser(request)
    assertSameOrigin(request)
    const { projectId } = await params
    await requireOwnedProject(projectId, auth)
    const { messageId } = await parseBody(request, z.object({ messageId: z.string().min(1).max(128) }).strict(), 1024)
    const { error } = await createAdminSupabaseClient().from('messages').update({ status: 'interrupted', updated_at: new Date().toISOString() })
      .eq('project_id', projectId).eq('user_id', auth.user.id).eq('id', messageId).eq('role', 'assistant').eq('status', 'pending')
    if (error) throw error
    return apiJson({ stopped: true }, requestId)
  } catch (error) { return apiFailure(error, requestId) }
}
