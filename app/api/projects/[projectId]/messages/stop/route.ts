import { z } from 'zod'
import { ApiError, apiFailure, apiJson, assertSameOrigin, parseBody, requireOwnedProject, requireUser } from '@/lib/server/api'
import { createAdminSupabaseClient } from '@/lib/supabase/server'
import { awaitMutationReceipt } from '@/lib/mutation-receipt'

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const requestId = crypto.randomUUID()
  try {
    const auth = await requireUser(request)
    assertSameOrigin(request)
    const { projectId } = await params
    await requireOwnedProject(projectId, auth)
    const { messageId, requestId: generationId } = await parseBody(request, z.object({ messageId: z.string().min(1).max(128), requestId: z.string().uuid() }).strict(), 1024)
    // Retry reuses the assistant row. Fence by the generation identity too,
    // so a delayed Stop cannot interrupt a newer request in another tab.
    try {
      const { error } = await awaitMutationReceipt(async signal => await createAdminSupabaseClient().from('messages')
        .update({ status: 'interrupted', updated_at: new Date().toISOString() })
        .eq('project_id', projectId).eq('user_id', auth.user.id).eq('id', messageId).eq('request_id', generationId)
        .eq('role', 'assistant').eq('status', 'pending').abortSignal(signal), request.signal, 10_000, 'Stop confirmation timed out.')
      if (error) throw error
    } catch { throw new ApiError(502, 'CHAT_STOP_UNCONFIRMED', 'The stop could not be confirmed. Reconnect to the saved response before retrying.') }
    return apiJson({ stopped: true }, requestId)
  } catch (error) { return apiFailure(error, requestId) }
}
