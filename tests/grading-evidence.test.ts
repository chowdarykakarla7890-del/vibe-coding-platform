import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { gradingSummarySchema } from '@/lib/learning/grading-evidence'
import { finishGradingEvidence, prepareGradingEvidence, readGradingSummary, type GradingPlan, type GradingReport } from '@/lib/server/grading-evidence'
import type { AuthContext } from '@/lib/server/api'
import { gradingSummary } from './fixtures/grading-evidence'

const db = vi.hoisted(() => ({ rpc: vi.fn(), abortSignal: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/server', () => ({ createAdminSupabaseClient: () => db }))
const userId = '11111111-1111-4111-8111-111111111111', projectId = '22222222-2222-4222-8222-222222222222'
const id = '33333333-3333-4333-8333-333333333333'
const auth = { user: { id: userId } } as AuthContext
const plan: GradingPlan = {
  version: 1, checkVersion: gradingSummary.checkVersion, sourceDigest: gradingSummary.sourceDigest,
  harnessDigest: gradingSummary.harnessDigest, runtimeDigest: gradingSummary.runtimeDigest,
  activityId: 'dsa-python-two-sum', language: 'JavaScript',
  cases: Array.from({ length: 24 }, () => ({ input: { nums: [1, 2], target: 3 }, label: 'Private case' })),
}
const report: GradingReport = { compileFailure: null, cases: Array.from({ length: 24 }, (_, n) => ({ output: '[0,1]', failure: null, passed: n < 23 })) }
const receipt = { submissionId: id, planDigest: gradingSummary.planDigest, caseCount: 24 }
const signal = () => new AbortController().signal
beforeEach(() => {
  db.rpc.mockReturnValue({ abortSignal: db.abortSignal })
  db.abortSignal.mockResolvedValue({ data: receipt, error: null })
})
afterEach(() => vi.resetAllMocks())

it('stores the exact cases under the authenticated user and validates the receipt', async () => {
  await expect(prepareGradingEvidence(auth, id, plan, signal())).resolves.toEqual(receipt)
  expect(db.rpc).toHaveBeenCalledExactlyOnceWith('prepare_submission_grading', { p_user_id: userId, p_submission_id: id, p_plan: plan })
  expect(db.abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal))
})

it.each([null, {}, { ...receipt, submissionId: projectId }, { ...receipt, caseCount: 23 }, { ...receipt, raw: 'private' }])('rejects invalid or mismatched plan acknowledgment %j', async data => {
  db.abortSignal.mockResolvedValue({ data, error: null })
  await expect(prepareGradingEvidence(auth, id, plan, signal())).rejects.toMatchObject({ status: 502, code: 'GRADING_EVIDENCE_UNAVAILABLE' })
})

it.each([
  ['SUBMISSION_NOT_FOUND', 404], ['SUBMISSION_STORAGE_LIMIT', 429], ['SUBMISSION_CLOSED', 409],
  ['private backend details / provider token', 502],
])('maps %s without exposing backend details', async (message, status) => {
  db.abortSignal.mockResolvedValue({ data: null, error: { message } })
  const error = await prepareGradingEvidence(auth, id, plan, signal()).catch(e => e)
  expect(error).toMatchObject({ status })
  expect(error.message).not.toContain('private backend')
})

it('acknowledges the retained report without adding raw results to the summary', async () => {
  db.abortSignal.mockResolvedValue({ data: gradingSummary, error: null })
  await expect(finishGradingEvidence(auth, id, receipt.planDigest, report, signal())).resolves.toEqual(gradingSummary)
  expect(db.rpc).toHaveBeenCalledExactlyOnceWith('finish_submission_grading', { p_user_id: userId, p_submission_id: id, p_plan_digest: receipt.planDigest, p_report: report })
})

it.each([
  { ...gradingSummary, planDigest: 'e'.repeat(64) },
  { ...gradingSummary, status: 'prepared', passedCount: null, completedAt: null, outcomes: [] },
  { ...gradingSummary, passedCount: 24, outcomes: Array(24).fill('passed') },
  { ...gradingSummary, outcomes: ['wrong-answer', ...Array(23).fill('passed')] },
  { ...gradingSummary, rawCases: plan.cases },
])('rejects inconsistent or unsafe report acknowledgment %j', async data => {
  db.abortSignal.mockResolvedValue({ data, error: null })
  await expect(finishGradingEvidence(auth, id, receipt.planDigest, report, signal())).rejects.toMatchObject({ code: 'GRADING_EVIDENCE_UNAVAILABLE' })
})

it.each([
  { ...report, cases: [] },
  { ...report, compileFailure: 'timeout' },
  { ...report, cases: [{ output: '', failure: 'timeout', passed: true }, ...report.cases.slice(1)] },
])('does not send incomplete or contradictory reports %j', async value => {
  await expect(finishGradingEvidence(auth, id, receipt.planDigest, value as GradingReport, signal())).rejects.toThrow()
  expect(db.rpc).not.toHaveBeenCalled()
})

it('supports compile failures without fabricated per-case outcomes', async () => {
  const summary = { ...gradingSummary, compileFailure: 'execution-error', outcomes: [], passedCount: 0 }
  db.abortSignal.mockResolvedValue({ data: summary, error: null })
  await expect(finishGradingEvidence(auth, id, receipt.planDigest, { compileFailure: 'execution-error', cases: [] }, signal())).resolves.toEqual(summary)
})

it('loads summaries with explicit account, project and submission scope; legacy is null', async () => {
  db.abortSignal.mockResolvedValueOnce({ data: gradingSummary, error: null }).mockResolvedValueOnce({ data: null, error: null })
  await expect(readGradingSummary(auth, projectId, id, signal())).resolves.toEqual(gradingSummary)
  expect(db.rpc).toHaveBeenCalledWith('read_submission_grading_summary', { p_user_id: userId, p_project_id: projectId, p_submission_id: id })
  await expect(readGradingSummary(auth, projectId, id, signal())).resolves.toBeNull()
})

it('never starts or acknowledges work after cancellation', async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(prepareGradingEvidence(auth, id, plan, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(db.rpc).not.toHaveBeenCalled()
  const active = new AbortController()
  db.abortSignal.mockImplementation(async () => { active.abort(); return { data: receipt, error: null } })
  await expect(prepareGradingEvidence(auth, id, plan, active.signal)).rejects.toMatchObject({ name: 'AbortError' })
})

it.each([
  { ...gradingSummary, passedCount: 24 }, { ...gradingSummary, outcomes: [] },
  { ...gradingSummary, completedAt: null }, { ...gradingSummary, caseCount: 25 },
  { ...gradingSummary, cases: plan.cases },
])('rejects invalid safe-summary projection %j', value => expect(gradingSummarySchema.safeParse(value).success).toBe(false))
