import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordSubmissionAssessment } from '@/lib/server/activity-submissions'
import type { AuthContext } from '@/lib/server/api'
import type { VerificationResult } from '@/lib/learning/types'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/server', () => ({ createAdminSupabaseClient: () => ({ rpc }) }))
const commit = vi.fn()
const userId = '11111111-1111-4111-8111-111111111111'
const id = '22222222-2222-4222-8222-222222222222'
const auth = { user: { id: userId } } as AuthContext
const result: VerificationResult = { score: 85, passed: true, aiAssessed: true, feedback: ['Synthetic feedback'], requestId: id, commandOutput: 'No code executed.' }
beforeEach(() => { rpc.mockReturnValue({ abortSignal: commit }); commit.mockResolvedValue({ data: { id, sourceCurrent: true }, error: null }) })
afterEach(() => vi.resetAllMocks())

describe('assessment commit receipts', () => {
  it('persists trusted checks as command evidence rather than relabeling them as an AI rubric', async () => {
    await recordSubmissionAssessment(auth, id, { ...result, aiAssessed: false })
    expect(rpc).toHaveBeenCalledWith('record_submission_assessment', expect.objectContaining({ p_ai_assessed: false, p_verification_kind: 'command' }))
  })
  it('confirms the exact owned submission and uses a bounded save request', async () => {
    await expect(recordSubmissionAssessment(auth, id, result)).resolves.toEqual({ id, sourceCurrent: true })
    expect(rpc).toHaveBeenCalledWith('record_submission_assessment', expect.objectContaining({ p_user_id: userId, p_submission_id: id, p_score: 85 }))
    expect(commit).toHaveBeenCalledWith(expect.any(AbortSignal))
  })
  it.each([null, {}, { id: userId, sourceCurrent: true }, { id, sourceCurrent: 'true' }, { id: 'invalid', sourceCurrent: false }])('does not claim success for a malformed or mismatched receipt', async (data) => {
    commit.mockResolvedValue({ data, error: null })
    await expect(recordSubmissionAssessment(auth, id, result)).rejects.toMatchObject({ status: 502, code: 'ASSESSMENT_RECEIPT_INVALID' })
  })
  it('retains a valid older-source receipt without claiming the latest code passed', async () => {
    commit.mockResolvedValue({ data: { id, sourceCurrent: false }, error: null })
    await expect(recordSubmissionAssessment(auth, id, result)).resolves.toEqual({ id, sourceCurrent: false })
  })
  it('does not expose private database failure details', async () => {
    commit.mockResolvedValue({ error: { message: 'private source sentinel', details: 'private diagnostic' } })
    await expect(recordSubmissionAssessment(auth, id, result)).rejects.toMatchObject({ status: 502, code: 'SUBMISSION_UNAVAILABLE' })
    await expect(recordSubmissionAssessment(auth, id, result)).rejects.not.toThrow('private')
  })
})
