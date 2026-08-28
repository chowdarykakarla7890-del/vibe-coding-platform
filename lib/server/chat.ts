import 'server-only'
import type { ChatUIMessage } from '@/components/chat/types'
import type { ChatRequestBody } from '@/ai/chat-request'
import { createAdminSupabaseClient } from '@/lib/supabase/server'
import type { Json } from '@/lib/supabase/database.types'
import { chatRowSchema, decodeChatRows } from '@/lib/chat/serialization'
import { ApiError, type AuthContext } from './api'

export async function beginChatTurn(auth: AuthContext, input: ChatRequestBody, requestId: string, modelId: string) {
  const { data, error } = await createAdminSupabaseClient().rpc('begin_chat_turn', {
    p_user_id: auth.user.id, p_project_id: input.projectId, p_message_id: input.message.id,
    p_parts: input.message.parts, p_model_id: modelId, p_request_id: requestId, p_retry: input.retry,
  })
  if (error?.message === 'PROJECT_NOT_FOUND') throw new ApiError(404, 'PROJECT_NOT_FOUND', 'Project not found.')
  if (error?.message === 'CHAT_BUSY') throw new ApiError(409, 'CHAT_BUSY', 'This project already has a response in progress. Wait for it to finish or stop it first.')
  if (error && ['MESSAGE_EXISTS','MESSAGE_CONFLICT'].includes(error.message)) throw new ApiError(409, error.message, 'This message was already saved or changed. Reload the conversation before retrying.')
  if (error || !data) throw error ?? new Error('Chat turn could not be reserved.')
  return data
}

export async function loadAuthoritativeHistory(auth: AuthContext, projectId: string, assistantId: string) {
  const { data, error } = await auth.supabase.from('messages').select('id,role,parts,status,model_id,ordinal,updated_at')
    .eq('user_id', auth.user.id).eq('project_id', projectId).neq('id', assistantId)
    .eq('status', 'complete').order('ordinal', { ascending: false }).limit(200)
  if (error) throw error
  const rows = data.reverse()
  // A bounded history may start halfway through a turn. Never send an orphaned
  // assistant/tool response without the user's preceding request.
  while (rows[0]?.role === 'assistant') rows.shift()
  return decodeChatRows(rows.map((row) => chatRowSchema.parse(row)))
}

export async function saveAssistantTurn(auth: AuthContext, projectId: string, assistantId: string, requestId: string, message: ChatUIMessage | undefined, status: 'pending' | 'complete' | 'failed' | 'interrupted') {
  const parts = message?.parts
  if (parts && Buffer.byteLength(JSON.stringify(parts)) > 1_000_000) throw new ApiError(413, 'RESPONSE_TOO_LARGE', 'The tutor response exceeded its saved-history limit.')
  const { data, error } = await createAdminSupabaseClient().from('messages').update({
    ...(parts ? { parts: JSON.parse(JSON.stringify(parts)) as Json } : {}), status, updated_at: new Date().toISOString(),
  }).eq('user_id', auth.user.id).eq('project_id', projectId).eq('id', assistantId).eq('request_id', requestId).eq('status', 'pending')
    .select('id').abortSignal(AbortSignal.timeout(10_000)).maybeSingle()
  if (error) throw error
  if (!data) throw new ApiError(409, 'CHAT_REPLACED', 'This response was stopped or superseded. Reload the saved conversation.')
}
