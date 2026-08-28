import { z } from 'zod'
import { apiFailure, apiJson, assertSameOrigin, parseBody, requireUser } from '@/lib/server/api'
import { createOwnedSandbox, sandboxSettingsSchema } from '@/lib/server/sandbox'

const bodySchema = sandboxSettingsSchema.extend({ projectId: z.string().uuid() }).strict()
export const maxDuration = 150

export async function POST(request: Request) {
  const requestId = crypto.randomUUID()
  try {
    const auth = await requireUser(request)
    assertSameOrigin(request)
    const body = await parseBody(request, bodySchema, 4 * 1024)
    const sandbox = await createOwnedSandbox(auth, body.projectId, body, request.signal)
    return apiJson({ sandboxId: sandbox.sandboxId, status: sandbox.status, requestId }, requestId, 201)
  } catch (error) { return apiFailure(error, requestId) }
}
