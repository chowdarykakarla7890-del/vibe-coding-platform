import { ApiError, apiFailure, apiJson, requestBodyFailure, requireOwnedSandboxRecord, requireUser } from '@/lib/server/api'
import { getOwnedSandbox, sandboxForRequest } from '@/lib/server/sandbox'
import { NextResponse, type NextRequest } from 'next/server'
import { isSandboxUnavailableError } from '@/ai/sandbox'
import { isSafeSnapshotPath, MAX_SOURCE_FILE_BYTES, sourceByteLength } from '@/lib/learning/snapshots'
import z from 'zod/v3'
import { writeSandboxFilesForRequest } from '@/lib/server/source-files'
import { sourceRevisionSchema } from '@/lib/source-version'
import { readJsonBody } from '@/lib/request-body'
import { readSandboxTextFile, withSandboxFileRead } from '@/lib/server/sandbox-file-read'

export const maxDuration = 60

const FileParamsSchema = z.object({
  sandboxId: z.string(),
  path: z.string(),
})

const UpdateFileSchema = z.object({
  path: z.string().min(1).max(240),
  content: z.string().max(MAX_SOURCE_FILE_BYTES).refine(value => !value.includes('\0')),
  revision: sourceRevisionSchema.optional(),
}).strict()

const CreateNodeSchema = z.object({
  path: z.string().min(1).max(240),
  type: z.enum(['file', 'folder']),
}).strict()

function sandboxFailure(error: unknown, action: string, requestId: string) {
  if (error instanceof ApiError) return apiFailure(error, requestId)
  if (isSandboxUnavailableError(error)) {
    return apiFailure(new ApiError(410, 'SANDBOX_EXPIRED', 'The sandbox has expired. Restore the project to continue.'), requestId)
  }
  console.error(`Sandbox file ${action} failed`, {
    requestId,
    errorName: error instanceof Error ? error.name : 'UnknownError',
  })
  return apiFailure(new ApiError(502, 'SANDBOX_FILE_FAILED', `Unable to ${action} the sandbox file.`), requestId)
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sandboxId: string }> }
) {
  const requestId = crypto.randomUUID()
  const { sandboxId } = await params
  const fileParams = FileParamsSchema.safeParse({
    path: request.nextUrl.searchParams.get('path'),
    sandboxId,
  })

  if (fileParams.success === false || !isSafeSnapshotPath(fileParams.data.path)) {
    return apiJson(
      {
        error: {
          code: 'INVALID_FILE_PATH',
          message: 'Pass a safe relative file path.',
          requestId,
        },
      },
      requestId, 400
    )
  }

  try {
    return await withSandboxFileRead(request.signal, async signal => {
      const auth = await requireUser(request)
      signal.throwIfAborted()
      const registration = await requireOwnedSandboxRecord(sandboxId, auth, signal)
      signal.throwIfAborted()
      const { data: saved, error } = await auth.supabase.from('source_files').select('content,revision,deleted')
        .eq('project_id', registration.project_id).eq('user_id', auth.user.id).eq('path', fileParams.data.path)
        .abortSignal(signal).maybeSingle()
      signal.throwIfAborted()
      if (error) throw new ApiError(502, 'SOURCE_READ_FAILED', 'The saved file could not be read. Retry without clearing your draft.')
      if (saved?.deleted) throw new ApiError(404, 'FILE_DELETED', 'This saved file was deleted. Your open draft is unchanged.', { 'X-Source-Revision': String(saved.revision) })
      // Source in the database is authoritative. Do not label an older VM copy
      // with a newer revision while a save is still being applied to the VM.
      if (saved) return new NextResponse(saved.content, { headers: {
        'Content-Type': 'text/plain; charset=utf-8', 'X-Source-Revision': String(saved.revision), 'Cache-Control': 'private, no-store', 'X-Request-Id': requestId,
      } })
      // Only unsaved VM files require a live environment. Never resume a stopped
      // sandbox just to open a durable source snapshot.
      const sandbox = await getOwnedSandbox(auth, sandboxId, registration.project_id, signal)
      const content = await readSandboxTextFile(sandbox, fileParams.data.path, signal)
      if (content === null) {
        return apiJson(
          {
            error: {
              code: 'FILE_NOT_FOUND',
              message: 'The file was not found in this sandbox.',
              requestId,
            },
          },
          requestId, 404
        )
      }

      return new NextResponse(content, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Source-Revision': '0', 'Cache-Control': 'private, no-store', 'X-Request-Id': requestId },
      })
    })
  } catch (error) {
    return sandboxFailure(error, 'read', requestId)
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ sandboxId: string }> }
) {
  const requestId = crypto.randomUUID()
  const { sandboxId } = await params
  const payload = await readJsonBody(request, 2 * 1024 * 1024)
  if (!payload.ok) return apiFailure(requestBodyFailure(payload.reason, 'INVALID_FILE_UPDATE'), requestId)
  const body = UpdateFileSchema.safeParse(payload.data)

  if (!body.success || !isSafeSnapshotPath(body.data.path) || sourceByteLength(body.data.content) > MAX_SOURCE_FILE_BYTES) {
    return apiJson(
      { error: { code: 'INVALID_FILE_UPDATE', message: 'The file path or content is invalid.', requestId } },
      requestId, 400
    )
  }

  try {
    if (request.signal.aborted) throw requestBodyFailure('aborted')
    const receipts = await writeSandboxFilesForRequest(request, sandboxId, [body.data])
    return apiJson({ path: body.data.path, saved: true, revision: receipts[0].revision, requestId }, requestId)
  } catch (error) {
    return sandboxFailure(error, 'save', requestId)
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sandboxId: string }> }
) {
  const requestId = crypto.randomUUID()
  const { sandboxId } = await params
  const payload = await readJsonBody(request, 4 * 1024)
  if (!payload.ok) return apiFailure(requestBodyFailure(payload.reason, 'INVALID_FILE_PATH'), requestId)
  const body = CreateNodeSchema.safeParse(payload.data)

  if (!body.success || !isSafeSnapshotPath(body.data.path.replace(/\/+$/, ''))) {
    return apiJson(
      { error: { code: 'INVALID_FILE_PATH', message: 'Use a safe relative file path.', requestId } },
      requestId, 400
    )
  }

  try {
    const path = body.data.path.replace(/\/+$/, '')
    if (request.signal.aborted) throw requestBodyFailure('aborted')

    if (body.data.type === 'folder') {
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)])
      const sandbox = await sandboxForRequest(request, sandboxId, signal)
      signal.throwIfAborted()
      await sandbox.mkDir(path, { signal })
      return apiJson({ path: `${path}/`, type: 'folder', requestId }, requestId)
    }

    await writeSandboxFilesForRequest(request, sandboxId, [{ path, content: '' }], true)
    return apiJson({ path, type: 'file', requestId }, requestId)
  } catch (error) {
    return sandboxFailure(error, 'create', requestId)
  }
}
