import { ApiError, apiFailure, apiJson, assertSameOrigin, requireOwnedProject, requireUser } from '@/lib/server/api'
import { assertArchiveId, deleteOwnedArchive, readOwnedArchive } from '@/lib/server/project-archive'
import { consumeQuota } from '@/lib/server/rate-limit'

type Context = { params: Promise<{ projectId: string; archiveId: string }> }
export async function GET(request: Request, { params }: Context) {
  const requestId = crypto.randomUUID()
  try {
    const auth = await requireUser(request)
    const { projectId, archiveId } = await params
    await requireOwnedProject(projectId, auth)
    assertArchiveId(archiveId)
    const query = new URL(request.url).searchParams
    const after = query.get('after') ?? '0'
    if (!/^(0|[1-9][0-9]{0,4})$/.test(after) || Number(after) > 50_000 || [...query.keys()].some(key => key !== 'after')) throw new ApiError(400, 'INVALID_ARCHIVE_CURSOR', 'Choose a valid archive page.')
    const quota = await consumeQuota(auth.user.id, 'archive-read')
    return apiJson(await readOwnedArchive(auth, projectId, archiveId, Number(after), request.signal), requestId, 200, quota)
  } catch (error) { return apiFailure(error, requestId) }
}

export async function DELETE(request: Request, { params }: Context) {
  const requestId = crypto.randomUUID()
  try {
    const auth = await requireUser(request)
    assertSameOrigin(request)
    const { projectId, archiveId } = await params
    await requireOwnedProject(projectId, auth)
    assertArchiveId(archiveId)
    return apiJson(await deleteOwnedArchive(auth, projectId, archiveId, request.signal), requestId)
  } catch (error) { return apiFailure(error, requestId) }
}
