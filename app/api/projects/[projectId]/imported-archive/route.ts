import { z } from 'zod'
import { ApiError, apiFailure, apiJson, requireOwnedProject, requireUser } from '@/lib/server/api'
import { ownedImportedArchive } from '@/lib/server/archive-import'
import { consumeQuota } from '@/lib/server/rate-limit'

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const requestId = crypto.randomUUID()
  try {
    const auth = await requireUser(request)
    const { projectId } = await context.params
    await requireOwnedProject(projectId, auth)
    const query = new URL(request.url).searchParams
    if ([...query.keys()].some(key => key !== 'after') || query.getAll('after').length > 1) throw new ApiError(400, 'INVALID_ARCHIVE_CURSOR', 'Choose a valid history page.')
    const raw = query.get('after') ?? '0'
    if (!/^(0|[1-9]\d{0,4})$/.test(raw) || !z.number().int().max(50_000).safeParse(Number(raw)).success) throw new ApiError(400, 'INVALID_ARCHIVE_CURSOR', 'Choose a valid history page.')
    const quota = await consumeQuota(auth.user.id, 'archive-read')
    return apiJson(await ownedImportedArchive(auth, projectId, Number(raw), request.signal), requestId, 200, quota)
  } catch (error) { return apiFailure(error, requestId) }
}
