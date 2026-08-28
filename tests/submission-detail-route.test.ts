import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GET } from '@/app/api/projects/[projectId]/submissions/[submissionId]/route'
import { ApiError, requireOwnedProject, requireUser } from '@/lib/server/api'
import { consumeQuota } from '@/lib/server/rate-limit'
import { readGradingSummary } from '@/lib/server/grading-evidence'
import { gradingSummary } from './fixtures/grading-evidence'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/server/api', async original => ({ ...await original<object>(), requireOwnedProject: vi.fn(), requireUser: vi.fn() }))
vi.mock('@/lib/server/rate-limit', () => ({ consumeQuota: vi.fn() }))
vi.mock('@/lib/server/grading-evidence', () => ({ readGradingSummary: vi.fn() }))
const userId = '11111111-1111-4111-8111-111111111111', projectId = '22222222-2222-4222-8222-222222222222'
const submissionId = '33333333-3333-4333-8333-333333333333', sourceId = '44444444-4444-4444-8444-444444444444'
const chain = () => {
  const query = { select: vi.fn(), eq: vi.fn(), abortSignal: vi.fn(), maybeSingle: vi.fn(), single: vi.fn() }
  for (const method of ['select', 'eq', 'abortSignal'] as const) query[method].mockReturnValue(query)
  return query
}
const submissions = chain(), sources = chain(), assessments = chain()
const from = vi.fn((table: string) => ({ activity_submissions: submissions, submission_sources: sources, assessments })[table])
const auth = { user: { id: userId }, supabase: { from } } as never
const context = { params: Promise.resolve({ projectId, submissionId }) }
const url = `http://localhost/api/projects/${projectId}/submissions/${submissionId}`
beforeEach(() => {
  vi.mocked(requireUser).mockResolvedValue(auth)
  vi.mocked(requireOwnedProject).mockResolvedValue({ id: projectId } as never)
  vi.mocked(consumeQuota).mockResolvedValue({
    'X-RateLimit-Limit': '60',
    'X-RateLimit-Remaining': '59',
    'X-RateLimit-Reset': '60',
  })
  vi.mocked(readGradingSummary).mockResolvedValue(gradingSummary)
  submissions.maybeSingle.mockResolvedValue({ data: { id: submissionId, source_id: sourceId, created_at: gradingSummary.createdAt, expires_at: '2026-08-27T00:05:00Z',
    state: 'complete', failure_code: null, source_versions: [{ path: 'main.js', revision: 1 }], manifest: { title: 'Retained activity' }, language: 'JavaScript', model_id: 'test/model' }, error: null })
  sources.single.mockResolvedValue({ data: { digest: gradingSummary.sourceDigest }, error: null })
  assessments.maybeSingle.mockResolvedValue({ data: { score: 95, passed: false, ai_assessed: false, feedback: ['23/24 checks'], source_current: true }, error: null })
})
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks() })

it('reads a safe summary with explicit owner/project filters, independent of any live sandbox', async () => {
  const response = await GET(new Request(url), context)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ id: submissionId, gradingSummary, score: 95, passed: false })
  expect(response.headers.get('x-request-id')).toBeTruthy()
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(response.headers.get('x-ratelimit-limit')).toBe('60')
  expect(readGradingSummary).toHaveBeenCalledWith(auth, projectId, submissionId, expect.any(AbortSignal))
  for (const query of [submissions, sources, assessments]) {
    expect(query.eq).toHaveBeenCalledWith('user_id', userId)
    expect(query.eq).toHaveBeenCalledWith('project_id', projectId)
  }
  expect(from).not.toHaveBeenCalledWith('sandbox_sessions')
})

it.each([401, 404, 429])('denies %s before querying evidence', async status => {
  const error = new ApiError(status, 'REQUEST_DENIED', 'Unavailable')
  if (status === 401) vi.mocked(requireUser).mockRejectedValueOnce(error)
  if (status === 404) vi.mocked(requireOwnedProject).mockRejectedValueOnce(error)
  if (status === 429) vi.mocked(consumeQuota).mockRejectedValueOnce(error)
  const response = await GET(new Request(url), context)
  expect(response.status).toBe(status)
  expect(from).not.toHaveBeenCalled()
  expect(readGradingSummary).not.toHaveBeenCalled()
})

it('does not read private evidence for a missing or cross-project submission', async () => {
  submissions.maybeSingle.mockResolvedValueOnce({ data: null, error: null })
  expect((await GET(new Request(url), context)).status).toBe(404)
  expect(readGradingSummary).not.toHaveBeenCalled()
  expect(sources.single).not.toHaveBeenCalled()
})

it('retains compatibility with older submissions with no grading evidence', async () => {
  vi.mocked(readGradingSummary).mockResolvedValueOnce(null)
  const response = await GET(new Request(url), context)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ gradingSummary: null, score: 95 })
})

it('returns a structured safe error if grading evidence cannot be verified', async () => {
  vi.mocked(readGradingSummary).mockRejectedValueOnce(new ApiError(502, 'GRADING_EVIDENCE_UNAVAILABLE', 'Summary unavailable'))
  const response = await GET(new Request(url), context)
  expect(response.status).toBe(502)
  expect(await response.json()).toEqual({ error: { code: 'GRADING_EVIDENCE_UNAVAILABLE', message: 'Summary unavailable', requestId: expect.any(String) } })
})

it('reads one submitted file without exposing a whole source snapshot or private report', async () => {
  sources.single.mockResolvedValueOnce({ data: { file: { path: 'main.js', content: 'saved code' } }, error: null })
  const response = await GET(new Request(`${url}?file=0`), context)
  expect(await response.json()).toEqual({ path: 'main.js', content: 'saved code', revision: 1 })
  expect(sources.select).toHaveBeenCalledWith('file:files->0')
  expect(readGradingSummary).not.toHaveBeenCalled()
})

it.each(['-1', '1', '0.5', '00', '1e3'])('rejects unsupported submitted-file index %s', async file => {
  expect((await GET(new Request(`${url}?file=${file}`), context)).status).toBe(400)
  expect(sources.single).not.toHaveBeenCalled()
  expect(readGradingSummary).not.toHaveBeenCalled()
})

it('rejects an invalid submission ID before querying', async () => {
  expect((await GET(new Request(url), { params: Promise.resolve({ projectId, submissionId: 'invalid' }) })).status).toBe(400)
  expect(from).not.toHaveBeenCalled()
})
