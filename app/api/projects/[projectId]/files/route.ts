import { ApiError, apiFailure, apiJson, assertSameOrigin, parseBody, requireOwnedProject, requireUser } from '@/lib/server/api'
import { versionedSourceFileSchema } from '@/lib/source-version'
import { isSafeSnapshotPath, MAX_PROJECT_FILES } from '@/lib/learning/snapshots'
import { z } from 'zod'
import { consumeQuota } from '@/lib/server/rate-limit'
import { saveOwnedSourceFiles } from '@/lib/server/source-files'

type Context = { params: Promise<{ projectId: string }> }
const filesSchema = z.object({ files: z.array(versionedSourceFileSchema).min(1).max(MAX_PROJECT_FILES)
  .refine((files) => new Set(files.map((file) => file.path)).size === files.length) }).strict()

export async function GET(request: Request, context: Context) {
  const requestId = crypto.randomUUID()
  try {
    const auth = await requireUser(request)
    const { projectId } = await context.params
    await requireOwnedProject(projectId, auth)
    const cursor = new URL(request.url).searchParams.get('after')
    if (cursor && !isSafeSnapshotPath(cursor)) throw new ApiError(400, 'INVALID_CURSOR', 'The source cursor is invalid.')
    let query = auth.supabase.from('source_files').select('path,content,updated_at,revision').eq('project_id', projectId).eq('user_id', auth.user.id).eq('deleted', false).order('path').limit(20)
    if (cursor) query = query.gt('path', cursor)
    const { data, error } = await query
    if (error) throw error
    const files: Array<{ path: string; content: string; updatedAt: number; revision: number }> = []
    let bytes = 0
    for (const row of data) {
      const file = { path: row.path, content: row.content, updatedAt: Date.parse(row.updated_at), revision: row.revision }
      const size = Buffer.byteLength(JSON.stringify(file)) + 1
      if (files.length && bytes + size > 2 * 1024 * 1024) break
      files.push(file)
      bytes += size
    }
    return apiJson({ files, nextCursor: (files.length < data.length || data.length === 20) ? files.at(-1)!.path : null }, requestId)
  } catch (error) { return apiFailure(error, requestId) }
}

export async function PUT(request: Request, context: Context) {
  const requestId = crypto.randomUUID()
  try {
    const auth = await requireUser(request)
    assertSameOrigin(request)
    const { projectId } = await context.params
    await requireOwnedProject(projectId, auth)
    const { files } = await parseBody(request, filesSchema, 2 * 1024 * 1024 + 1024)
    const quota = await consumeQuota(auth.user.id, 'source-write')
    const receipts = await saveOwnedSourceFiles(auth, projectId, files)
    return apiJson({ saved: files.length, receipts }, requestId, 200, quota)
  } catch (error) { return apiFailure(error, requestId) }
}
