import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, requireOwnedProject, requireOwnedSandbox, requireUser, type AuthContext } from '@/lib/server/api'
import { getOwnedSandbox } from '@/lib/server/sandbox'
import { prepareOwnedFileWrites, saveOwnedSourceFiles, writeOwnedSandboxFiles, writeSandboxFilesForRequest } from '@/lib/server/source-files'
import { getWriteFiles } from '@/ai/tools/generate-files/get-write-files'
import { createAdminSupabaseClient } from '@/lib/supabase/server'
import { applySandboxSource, SourceApplyError } from '@/lib/sandbox/source-apply'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/server/api', async (original) => ({ ...await original<object>(), requireOwnedProject: vi.fn(), requireOwnedSandbox: vi.fn(), requireUser: vi.fn() }))
vi.mock('@/lib/server/sandbox', () => ({ getOwnedSandbox: vi.fn() }))
vi.mock('@/lib/server/rate-limit', () => ({ consumeQuota: async () => ({}) }))
vi.mock('@/lib/supabase/server', () => ({ createAdminSupabaseClient: vi.fn() }))
vi.mock('@/lib/sandbox/source-apply', async (original) => ({ ...await original<object>(), applySandboxSource: vi.fn() }))

const projectId = '550e8400-e29b-41d4-a716-446655440000'
const files = [{ path: 'src/main.ts', content: 'export const answer = 42' }]
const writeFiles = vi.mocked(applySandboxSource)
const readFile = vi.fn()
const commit = vi.fn()
const rpc = vi.fn()
const from = vi.fn()
const auth = { user: { id: 'account-a' }, supabase: { from } } as unknown as AuthContext

beforeEach(() => {
  rpc.mockReturnValue({ abortSignal: commit })
  vi.mocked(createAdminSupabaseClient).mockReturnValue({ rpc } as never)
  commit.mockResolvedValue({ data: [{ path: files[0].path, revision: 1 }], error: null })
  writeFiles.mockResolvedValue(undefined)
  readFile.mockResolvedValue(null)
  vi.mocked(requireUser).mockResolvedValue(auth)
  vi.mocked(requireOwnedProject).mockResolvedValue({ id: projectId } as never)
  vi.mocked(requireOwnedSandbox).mockResolvedValue({ project_id: projectId } as never)
  vi.mocked(getOwnedSandbox).mockResolvedValue({ writeFiles, readFile } as never)
  const query = { select: vi.fn(), eq: vi.fn(), in: vi.fn(), abortSignal: vi.fn(async () => ({ data: [], error: null })) }
  query.select.mockReturnValue(query); query.eq.mockReturnValue(query); query.in.mockReturnValue(query)
  from.mockReturnValue(query)
})
afterEach(() => { vi.resetAllMocks() })

describe('server-owned durable source writes', () => {
  it('commits the account/project-scoped batch before applying any sandbox file', async () => {
    let release!: (result: { data: Array<{ path: string; revision: number }>; error: null }) => void
    commit.mockReturnValue(new Promise((resolve) => { release = resolve }))
    const pending = writeOwnedSandboxFiles(auth, 'sandbox-a', files, { projectId })
    await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce())
    expect(writeFiles).not.toHaveBeenCalled()
    expect(rpc).toHaveBeenCalledWith('save_source_revision_batch', { p_project_id: projectId, p_user_id: 'account-a', p_files: [{ ...files[0], revision: 0 }], p_create_only: false })
    release({ data: [{ path: files[0].path, revision: 1 }], error: null })
    await pending
    expect(writeFiles).toHaveBeenCalledWith(expect.any(Object), [{ ...files[0], revision: 1 }])
    expect(commit).toHaveBeenCalledWith(expect.any(AbortSignal))
  })

  it('does not mutate the sandbox if cloud persistence fails', async () => {
    commit.mockResolvedValue({ error: { message: 'private database detail' } })
    await expect(writeOwnedSandboxFiles(auth, 'sandbox-a', files)).rejects.toMatchObject({ code: 'SOURCE_SAVE_FAILED', status: 502 })
    expect(writeFiles).not.toHaveBeenCalled()
  })

  it('keeps the recoverable source if sandbox application fails', async () => {
    writeFiles.mockRejectedValue(new Error('private sandbox failure'))
    await expect(writeOwnedSandboxFiles(auth, 'sandbox-a', files)).rejects.toMatchObject({ code: 'SANDBOX_SOURCE_NOT_APPLIED', message: expect.stringContaining('Your source is saved') })
    expect(rpc).toHaveBeenCalledOnce()
    // No delete/rollback is attempted against the only durable copy.
    expect(from.mock.calls.every(([table]) => table === 'source_files')).toBe(true)
  })

  it('keeps the draft retryable if a newer version reached the VM first', async () => {
    writeFiles.mockRejectedValue(new SourceApplyError('SOURCE_SUPERSEDED'))
    await expect(writeOwnedSandboxFiles(auth, 'sandbox-a', files)).rejects.toMatchObject({ status: 409, code: 'SOURCE_SUPERSEDED' })
    expect(rpc).toHaveBeenCalledOnce()
  })

  it('retains durable source and reports closing when shutdown rejects a delayed VM write', async () => {
    writeFiles.mockRejectedValue(new SourceApplyError('SANDBOX_CLOSING'))
    await expect(writeOwnedSandboxFiles(auth, 'sandbox-a', files)).rejects.toMatchObject({ status: 409, code: 'SANDBOX_CLOSING', message: expect.stringContaining('Your source is saved') })
    expect(rpc).toHaveBeenCalledOnce()
    expect(from.mock.calls.every(([table]) => table === 'source_files')).toBe(true)
  })

  it('preserves saved and terminal versions when the live workspace changed independently', async () => {
    writeFiles.mockRejectedValue(new SourceApplyError('SOURCE_WORKSPACE_CHANGED'))
    await expect(writeOwnedSandboxFiles(auth, 'sandbox-a', files)).rejects.toMatchObject({ status: 409, code: 'SOURCE_WORKSPACE_CHANGED', message: expect.stringContaining('terminal version has not been replaced') })
    expect(rpc).toHaveBeenCalledOnce()
  })

  it('rejects another project before either storage system is written', async () => {
    await expect(writeOwnedSandboxFiles(auth, 'sandbox-a', files, { projectId: crypto.randomUUID() })).rejects.toMatchObject({ status: 404 })
    expect(getOwnedSandbox).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
  })

  it('leaves saved source alone when the registered sandbox has expired', async () => {
    vi.mocked(requireOwnedSandbox).mockRejectedValue(new ApiError(410, 'SANDBOX_EXPIRED', 'Restore this project.'))
    await expect(writeOwnedSandboxFiles(auth, 'sandbox-a', files)).rejects.toMatchObject({ status: 410 })
    expect(from).not.toHaveBeenCalled()
  })

  it.each([
    [{ path: '../escape', content: '' }],
    [{ path: '.env.local', content: '' }],
    [{ path: 'large.txt', content: '🙂'.repeat(65_537) }],
    [files[0], files[0]],
    [{ path: 'src', content: '' }, files[0]],
  ])('rejects invalid batches before database writes (%#)', async (...batch) => {
    await expect(saveOwnedSourceFiles(auth, projectId, batch)).rejects.toMatchObject({ code: 'INVALID_SOURCE' })
    expect(from).not.toHaveBeenCalled()
  })

  it('maps database project limits without changing the sandbox', async () => {
    commit.mockResolvedValue({ error: { code: '23514' } })
    await expect(writeOwnedSandboxFiles(auth, 'sandbox-a', files)).rejects.toMatchObject({ code: 'SOURCE_LIMIT', status: 413 })
    expect(writeFiles).not.toHaveBeenCalled()
  })

  it('reports a saved file/folder collision without applying any sandbox content', async () => {
    commit.mockResolvedValue({ error: { code: 'P0001', message: 'SOURCE_PATH_CONFLICT' } })
    await expect(writeOwnedSandboxFiles(auth, 'sandbox-a', files)).rejects.toMatchObject({ status: 409, code: 'SOURCE_PATH_CONFLICT' })
    expect(writeFiles).not.toHaveBeenCalled()
  })

  it('creates new files without overwriting an existing saved file', async () => {
    commit.mockResolvedValue({ error: { code: '23505' } })
    await expect(writeOwnedSandboxFiles(auth, 'sandbox-a', files, { createOnly: true })).rejects.toMatchObject({ code: 'FILE_ALREADY_EXISTS', status: 409 })
    expect(rpc).toHaveBeenCalledWith('save_source_revision_batch', expect.objectContaining({ p_create_only: true }))
    expect(writeFiles).not.toHaveBeenCalled()
  })

  it('does not overwrite a sandbox-only file when creating a new file', async () => {
    const close = vi.fn(async () => ({ done: true, value: undefined }))
    readFile.mockResolvedValue({ [Symbol.asyncIterator]: () => ({ return: close }) })
    await expect(writeOwnedSandboxFiles(auth, 'sandbox-a', files, { createOnly: true })).rejects.toMatchObject({ code: 'FILE_ALREADY_EXISTS' })
    expect(close).toHaveBeenCalledOnce()
    expect(rpc).not.toHaveBeenCalled()
    expect(writeFiles).not.toHaveBeenCalled()
  })

  it('recreates an explicitly requested deleted file using its existing revision fence', async () => {
    const read = vi.fn().mockResolvedValue({ data: [{ path: files[0].path, revision: 4 }], error: null })
    const query = { select: vi.fn(), eq: vi.fn(), in: vi.fn(), abortSignal: read }
    query.select.mockReturnValue(query); query.eq.mockReturnValue(query); query.in.mockReturnValue(query)
    from.mockReturnValue(query)
    commit.mockResolvedValue({ data: [{ path: files[0].path, revision: 5 }], error: null })
    await writeOwnedSandboxFiles(auth, 'sandbox-a', files, { createOnly: true })
    expect(query.eq).toHaveBeenCalledWith('deleted', true)
    expect(rpc).toHaveBeenCalledWith('save_source_revision_batch', expect.objectContaining({ p_create_only: true, p_files: [{ ...files[0], revision: 4 }] }))
    expect(writeFiles).toHaveBeenCalledWith(expect.any(Object), [{ ...files[0], revision: 5 }])
  })

  it('rejects a stale revision before applying sandbox contents', async () => {
    commit.mockResolvedValue({ error: { code: 'P0001', message: 'SOURCE_CONFLICT' } })
    await expect(writeOwnedSandboxFiles(auth, 'sandbox-a', [{ ...files[0], revision: 1 }])).rejects.toMatchObject({ status: 409, code: 'SOURCE_CONFLICT' })
    expect(writeFiles).not.toHaveBeenCalled()
  })

  it.each([
    { receipts: [{ path: 'unexpected.ts', revision: 1 }] },
    { receipts: [{ path: files[0].path, revision: 2_147_483_648 }] },
    { receipts: [{ path: files[0].path, revision: 0 }] },
    { receipts: [] },
  ])('does not apply sandbox files after an invalid save receipt (%#)', async ({ receipts }) => {
    commit.mockResolvedValue({ data: receipts, error: null })
    await expect(writeOwnedSandboxFiles(auth, 'sandbox-a', files)).rejects.toMatchObject({ code: 'SOURCE_RECEIPT_INVALID' })
    expect(writeFiles).not.toHaveBeenCalled()
  })

  it('rejects duplicated receipt paths even when the count matches', async () => {
    commit.mockResolvedValue({ data: [{ path: files[0].path, revision: 1 }, { path: files[0].path, revision: 1 }], error: null })
    await expect(writeOwnedSandboxFiles(auth, 'sandbox-a', [...files, { path: 'other.ts', content: '' }])).rejects.toMatchObject({ code: 'SOURCE_RECEIPT_INVALID' })
    expect(writeFiles).not.toHaveBeenCalled()
  })

  it('captures generation revisions before output and advances only acknowledged paths', async () => {
    const read = vi.fn().mockResolvedValue({ data: [{ path: files[0].path, revision: 3 }], error: null })
    const query = { select: vi.fn(), eq: vi.fn(), in: vi.fn(), abortSignal: read }
    query.select.mockReturnValue(query); query.eq.mockReturnValue(query); query.in.mockReturnValue(query)
    from.mockReturnValue(query)
    const save = await prepareOwnedFileWrites(auth, 'sandbox-a', projectId, [files[0].path, 'new.ts'])
    commit.mockResolvedValueOnce({ data: [{ path: files[0].path, revision: 4 }], error: null })
      .mockResolvedValueOnce({ data: [{ path: files[0].path, revision: 5 }, { path: 'new.ts', revision: 1 }], error: null })
    await save(files)
    await save([...files, { path: 'new.ts', content: '' }])
    expect(read).toHaveBeenCalledOnce()
    expect(rpc.mock.calls[0][1].p_files[0].revision).toBe(3)
    expect(rpc.mock.calls[1][1].p_files.map((file: { revision: number }) => file.revision)).toEqual([4, 0])
    await expect(save([{ path: 'not-requested.ts', content: '' }])).rejects.toMatchObject({ code: 'INVALID_SOURCE' })
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it('rejects a cross-origin mutation before paid resources or source writes', async () => {
    await expect(writeSandboxFilesForRequest(new Request('http://localhost/api/test', { method: 'PUT', headers: { origin: 'https://other.example' } }), 'sandbox-a', files)).rejects.toMatchObject({ status: 403 })
    expect(requireOwnedSandbox).not.toHaveBeenCalled()
    expect(from).not.toHaveBeenCalled()
  })
})

describe('generation progress acknowledges durable writes', () => {
  it('waits for the server save rather than starting a browser snapshot request', async () => {
    let release!: () => void
    const saveFiles = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const write = vi.fn()
    const save = getWriteFiles({ saveFiles, sandboxId: 'sandbox-a', toolCallId: 'tool-a', writer: { write } as never })
    const pending = save({ files, written: [], paths: [files[0].path] })
    expect(write.mock.calls.map(([event]) => event.data.status)).toEqual(['uploading'])
    expect(saveFiles).toHaveBeenCalledWith(files)
    release()
    await expect(pending).resolves.toBeUndefined()
    expect(write.mock.calls.map(([event]) => event.data.status)).toEqual(['uploading', 'uploaded'])
  })

  it('never emits uploaded on a storage failure and returns safe retry guidance', async () => {
    const write = vi.fn()
    const save = getWriteFiles({ saveFiles: async () => { throw new ApiError(502, 'SOURCE_SAVE_FAILED', 'Source could not be saved. Retry the save.') }, sandboxId: 'sandbox-a', toolCallId: 'tool-a', writer: { write } as never })
    await expect(save({ files, written: [], paths: [files[0].path] })).resolves.toContain('Retry')
    expect(write.mock.calls.map(([event]) => event.data.status)).toEqual(['uploading', 'error'])
  })
})
