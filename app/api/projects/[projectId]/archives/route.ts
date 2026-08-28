import { z } from 'zod'
import { apiFailure, apiJson, assertSameOrigin, parseBody, requireOwnedProject, requireUser } from '@/lib/server/api'
import { consumeQuota } from '@/lib/server/rate-limit'
import { createOwnedArchive } from '@/lib/server/project-archive'

export const maxDuration = 30
export async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const requestId = crypto.randomUUID()
  try {
    const auth = await requireUser(request)
    assertSameOrigin(request)
    const { projectId } = await params
    await requireOwnedProject(projectId, auth)
    const { archiveId } = await parseBody(request, z.object({ archiveId: z.string().uuid() }).strict(), 1024)
    const quota = await consumeQuota(auth.user.id, 'archive-create')
    return apiJson(await createOwnedArchive(auth, projectId, archiveId, request.signal), requestId, 201, quota)
  } catch (error) { return apiFailure(error, requestId) }
}
