import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveOwnedSourceConflict, assertConflictId, retryOwnedSourceCaptures } from '@/lib/server/source-recovery'
import { resolutionRequestSchema, recoveryStatusText } from '@/lib/source-recovery'
import type { AuthContext } from '@/lib/server/api'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/server', () => ({ createAdminSupabaseClient: () => ({ rpc }) }))
const commit = vi.fn()
const userId = '11111111-1111-4111-8111-111111111111', projectId = '22222222-2222-4222-8222-222222222222', id = '33333333-3333-4333-8333-333333333333'
const auth = { user: { id: userId } } as AuthContext
const receipt = { id, path: 'main.ts', choice: 'merged', revision: 4, deleted: false }
beforeEach(() => { rpc.mockReturnValue({ abortSignal: commit }); commit.mockResolvedValue({ data: receipt, error: null }) })
afterEach(() => vi.resetAllMocks())

describe('source resolution boundary', () => {
  it('retries only the authenticated owner and validates the bounded receipt', async () => {
    commit.mockResolvedValue({ data: 2, error: null })
    expect(await retryOwnedSourceCaptures(auth, projectId)).toBe(2)
    expect(rpc).toHaveBeenCalledWith('retry_source_captures', { p_user_id: userId, p_project_id: projectId })
    expect(commit).toHaveBeenCalledWith(expect.any(AbortSignal))
  })
  it.each([null, '1', -1, 11, 0.5])('does not confirm malformed retry receipt %s', async (data) => {
    commit.mockResolvedValue({ data, error: null })
    await expect(retryOwnedSourceCaptures(auth, projectId)).rejects.toMatchObject({ status: 502 })
  })
  it.each([['SANDBOX_EXPIRED', 410], ['PROJECT_NOT_FOUND', 404], ['private database error', 502]])('maps capture retry failure %s safely', async (message, status) => {
    commit.mockResolvedValue({ data: null, error: { message } })
    await expect(retryOwnedSourceCaptures(auth, projectId)).rejects.toMatchObject({ status })
    await expect(retryOwnedSourceCaptures(auth, projectId)).rejects.not.toThrow('private')
  })
  it('passes only trusted owner/project and validated decision fields to the bounded RPC', async () => {
    await expect(resolveOwnedSourceConflict(auth, projectId, id, { choice: 'merged', revision: 3, content: 'merged' })).resolves.toEqual(receipt)
    expect(rpc).toHaveBeenCalledWith('resolve_source_conflict', { p_user_id: userId, p_project_id: projectId, p_conflict_id: id, p_choice: 'merged', p_revision: 3, p_content: 'merged' })
    expect(commit).toHaveBeenCalledWith(expect.any(AbortSignal))
  })
  it.each([
    ['SOURCE_CONFLICT', 409], ['SOURCE_REVIEW_RESOLVED', 409], ['SOURCE_PATH_CONFLICT', 409],
    ['SOURCE_REVISION_EXHAUSTED', 409], ['SOURCE_REVIEW_NOT_FOUND', 404], ['PROJECT_NOT_FOUND', 404],
  ])('maps %s to a safe %i response', async (message, status) => {
    commit.mockResolvedValue({ error: { message } })
    await expect(resolveOwnedSourceConflict(auth, projectId, id, { choice: 'saved', revision: 3 })).rejects.toMatchObject({ status })
  })
  it('never forwards raw database messages or details', async () => {
    commit.mockResolvedValue({ error: { message: 'private source sentinel', details: 'private metadata' } })
    await expect(resolveOwnedSourceConflict(auth, projectId, id, { choice: 'saved', revision: 3 })).rejects.toMatchObject({ status: 502, code: 'SOURCE_RESOLUTION_FAILED' })
    await expect(resolveOwnedSourceConflict(auth, projectId, id, { choice: 'saved', revision: 3 })).rejects.not.toThrow('private')
  })
  it('retains copies when a resolution exceeds storage limits', async () => {
    commit.mockResolvedValue({ error: { code: '23514' } })
    await expect(resolveOwnedSourceConflict(auth, projectId, id, { choice: 'captured', revision: 3 })).rejects.toMatchObject({ status: 413, code: 'SOURCE_LIMIT' })
  })
  it.each([{ ...receipt, id: projectId }, { ...receipt, choice: 'saved' }, { ...receipt, revision: 2 }, { ...receipt, path: '../escape' }])('rejects a mismatched or malformed receipt', async (data) => {
    commit.mockResolvedValue({ data, error: null })
    await expect(resolveOwnedSourceConflict(auth, projectId, id, { choice: 'merged', revision: 3, content: '' })).rejects.toMatchObject({ code: 'INVALID_RESOLUTION_RECEIPT' })
  })
  it.each([{ choice: 'saved' }, { choice: 'captured', revision: 1, content: 'extra' }, { choice: 'merged', revision: 1, content: '\0' },
    { choice: 'merged', revision: 1, content: '🙂'.repeat(65537) }, { choice: 'saved', revision: 1.5 }, { choice: 'saved', revision: 1, sandboxId: 'forged' }])('rejects invalid public resolution input', (input) => {
    expect(resolutionRequestSchema.safeParse(input).success).toBe(false)
  })
  it('rejects malformed conflict IDs', () => { expect(() => assertConflictId('../other')).toThrow('valid source review'); expect(() => assertConflictId(id)).not.toThrow() })
  it('does not label incomplete or saved-only source as fully synchronized', () => {
    const page = { conflicts: [], nextCursor: null, unresolved: 0, pending: 0, incomplete: 0, expired: 0, savedOnly: 0 }
    expect(recoveryStatusText({ ...page, expired: 1 })).toContain('may not be saved')
    expect(recoveryStatusText({ ...page, incomplete: 1 })).toContain('may not be saved')
    expect(recoveryStatusText({ ...page, savedOnly: 1 })).toContain('review sandbox application')
    expect(recoveryStatusText({ ...page, pending: 1 })).toContain('Saving terminal')
    expect(recoveryStatusText({ ...page, incomplete: 1, paused: 1 })).toContain('paused')
  })
})
