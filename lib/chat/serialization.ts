import { safeValidateUIMessages } from 'ai'
import { z } from 'zod'
import { MODEL_NAMES } from '@/ai/constants'
import { dataPartSchema } from '@/ai/messages/data-parts'
import type { ChatUIMessage } from '@/components/chat/types'

export const chatRowSchema = z.object({
  id: z.string(), role: z.enum(['user', 'assistant']), parts: z.array(z.unknown()),
  status: z.enum(['pending', 'complete', 'failed', 'interrupted']),
  model_id: z.string().nullable(), ordinal: z.number().int().positive(),
  request_id: z.string().uuid().nullish(),
  updated_at: z.string().datetime({ offset: true }),
})
export const chatPageSchema = z.object({ messages: z.array(chatRowSchema).max(200), nextCursor: z.number().int().positive().nullable() })

export async function decodeChatRows(rows: z.infer<typeof chatRowSchema>[]): Promise<ChatUIMessage[]> {
  // Saved history is not a generation request: new projects legitimately have
  // no messages, and a reserved/failed assistant turn can have no parts yet.
  // The SDK intentionally rejects both shapes when validating model input.
  if (!rows.length) return []
  if (new Set(rows.map(row => row.id)).size !== rows.length || rows.some(row =>
    !row.parts.length && (row.role !== 'assistant' || row.status === 'complete'))) {
    throw new Error('Saved conversation data is invalid. Your history has not been cleared.')
  }
  const messages = rows.map((row) => {
    const metadata: ChatUIMessage['metadata'] = row.role === 'assistant' ? {
      model: row.model_id ? MODEL_NAMES[row.model_id] ?? row.model_id : 'Tutor',
      ...(row.request_id ? { requestId: row.request_id } : {}),
      persistenceStatus: row.status === 'pending' && Date.parse(row.updated_at) < Date.now() - 120_000 ? 'interrupted' : row.status,
    } : undefined
    return {
      id: row.id, role: row.role, parts: row.parts,
      metadata,
    }
  })
  const populated = messages.filter(message => message.parts.length)
  const result = populated.length ? await safeValidateUIMessages<ChatUIMessage>({
    messages: populated,
    dataSchemas: dataPartSchema.shape,
  }) : { success: true as const, data: [] as ChatUIMessage[] }
  if (!result.success) throw new Error('Saved conversation data is invalid. Your history has not been cleared.')
  let index = 0
  return messages.map(message => message.parts.length ? result.data[index++] : {
    id: message.id, role: 'assistant', parts: [], metadata: message.metadata,
  })
}
