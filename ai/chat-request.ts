import { SUPPORTED_MODELS } from './constants'
import { z } from 'zod/v3'

// JSON escaping can expand a 32 KB text message sixfold.
export const MAX_CHAT_REQUEST_BYTES = 208 * 1024
export const MAX_USER_MESSAGE_BYTES = 32 * 1024

export const chatMessageSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  role: z.literal('user'),
  parts: z.array(z.object({ type: z.literal('text'), text: z.string() }).strict()).min(1).max(16),
}).strict()

const chatBodySchema = z.object({
  projectId: z.string().uuid(),
  message: chatMessageSchema,
  modelId: z.string().min(1).max(120).optional(),
  reasoningEffort: z.enum(['low', 'medium']).optional(),
  retry: z.boolean().default(false),
}).strict()

export type ChatRequestBody = z.output<typeof chatBodySchema>

export function parseChatRequestBody(value: unknown):
  | { ok: true; data: ChatRequestBody }
  | { ok: false; code: string; message: string; status: number } {
  const parsed = chatBodySchema.safeParse(value)
  if (!parsed.success) return { ok: false, code: 'INVALID_REQUEST', message: 'Send one user message and a valid project.', status: 400 }
  if (parsed.data.modelId && !SUPPORTED_MODELS.includes(parsed.data.modelId)) {
    return { ok: false, code: 'UNSUPPORTED_MODEL', message: 'Choose a supported model.', status: 400 }
  }
  const text = parsed.data.message.parts.map((part) => part.text).join('')
  if (!text.trim()) return { ok: false, code: 'EMPTY_MESSAGE', message: 'Enter a message for the tutor.', status: 400 }
  if (new TextEncoder().encode(text).byteLength > MAX_USER_MESSAGE_BYTES) {
    return { ok: false, code: 'MESSAGE_TOO_LARGE', message: 'Keep the message under 32 KB.', status: 413 }
  }
  return { ok: true, data: parsed.data }
}
