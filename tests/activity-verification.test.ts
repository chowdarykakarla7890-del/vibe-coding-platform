import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from '@/app/api/activities/verify/route'
import { ApiError, requireOwnedProject, requireOwnedSandboxRecord, requireUser } from '@/lib/server/api'
import { findOwnedActivity } from '@/lib/server/activities'
import { beginActivitySubmission, failActivitySubmission, recordSubmissionAssessment } from '@/lib/server/activity-submissions'
import { getOwnedSandbox } from '@/lib/server/sandbox'
import { runOwnedCommand } from '@/lib/server/owned-command'
import { generateText } from 'ai'
import type { ActivityManifest } from '@/lib/learning/types'
import { GatewayInternalServerError } from '@ai-sdk/gateway'
import { DSA_LANGUAGES, dsaEntryPath, foundationDSAActivity } from '@/lib/learning/dsa-foundations'
import { TRUSTED_DSA_IDS, trustedDSAActivity } from '@/lib/learning/dsa'
import { gradeDSASubmission } from '@/lib/server/dsa-grading'
import { gradeChallengeSubmission } from '@/lib/server/challenge-grading'
import { TRUSTED_CHALLENGE_IDS, trustedChallengeActivity } from '@/lib/learning/challenges/contracts'
import { consumeQuota } from '@/lib/server/rate-limit'
import { checkBotId } from 'botid/server'

vi.mock('server-only', () => ({}))
vi.mock('botid/server', () => ({ checkBotId: vi.fn() }))
vi.mock('@/lib/server/challenge-grading', async original => ({ ...await original<typeof import('@/lib/server/challenge-grading')>(), gradeChallengeSubmission: vi.fn() }))
vi.mock('@/lib/server/dsa-grading', async original => ({ ...await original<typeof import('@/lib/server/dsa-grading')>(), gradeDSASubmission: vi.fn() }))
vi.mock('@/lib/server/api', async (original) => ({ ...await original<typeof import('@/lib/server/api')>(), requireUser: vi.fn(), requireOwnedProject: vi.fn(), requireOwnedSandboxRecord: vi.fn() }))
vi.mock('@/lib/server/activities', () => ({ findOwnedActivity: vi.fn() }))
vi.mock('@/lib/server/activity-submissions', async (original) => ({ ...await original<typeof import('@/lib/server/activity-submissions')>(), beginActivitySubmission: vi.fn(), recordSubmissionAssessment: vi.fn(), failActivitySubmission: vi.fn() }))
vi.mock('@/lib/server/sandbox', () => ({ getOwnedSandbox: vi.fn() }))
vi.mock('@/lib/server/owned-command', () => ({ runOwnedCommand: vi.fn() }))
vi.mock('@/lib/server/rate-limit', () => ({ consumeQuota: vi.fn(async () => ({ 'X-RateLimit-Limit': '10' })) }))
vi.mock('@/ai/gateway', () => ({ getModelOptions: vi.fn(() => ({ model: 'test' })) }))
vi.mock('ai', async (original) => ({ ...await original<typeof import('ai')>(), generateText: vi.fn(), Output: { object: vi.fn() } }))

const projectId = '550e8400-e29b-41d4-a716-446655440000'
const activity: ActivityManifest = { id: 'practice-test', title: 'Example activity', language: 'JavaScript', concepts: ['functions'],
  mode: 'practice', summary: 'Implement a function using source code.', difficulty: 'beginner', estimatedMinutes: 10,
  instructions: ['Implement solve and return one.'], source: 'curated',
  starterFiles: [{ path: 'main.js', content: '// TODO' }], verify: { kind: 'command', command: { executable: 'node', args: ['main.js'] } },
  rubric: [{ id: 'correctness', label: 'Correctness', weight: 100 }] }
const body = { projectId, activityId: activity.id, sandboxId: 'sbx_test', modelId: 'openai/gpt-5-nano' }
const submitted = (id = crypto.randomUUID()) => ({ id, project_id: projectId, user_id: 'test-user', source_id: crypto.randomUUID(),
  source_versions: [{ path: 'main.js', revision: 1 }], manifest: activity, language: activity.language, model_id: body.modelId, reflection: '',
  state: 'pending' as const, expires_at: new Date(Date.now() + 300000).toISOString(), digest: 'a'.repeat(64),
  files: [{ path: 'main.js', content: 'export const solve = () => 1' }] })
function request(input: unknown = body, signal?: AbortSignal) {
  return new Request('http://localhost/api/activities/verify', { method: 'POST', signal, headers: { origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify(input) })
}
beforeEach(() => {
  vi.mocked(checkBotId).mockResolvedValue({ isBot: false } as Awaited<ReturnType<typeof checkBotId>>)
  vi.mocked(requireUser).mockResolvedValue({ user: { id: 'test-user' } } as Awaited<ReturnType<typeof requireUser>>)
  vi.mocked(requireOwnedProject).mockResolvedValue({ id: projectId, activity_id: activity.id, language: activity.language } as Awaited<ReturnType<typeof requireOwnedProject>>)
  vi.mocked(requireOwnedSandboxRecord).mockResolvedValue({ project_id: projectId, status: 'expired' } as Awaited<ReturnType<typeof requireOwnedSandboxRecord>>)
  vi.mocked(findOwnedActivity).mockResolvedValue(activity)
  vi.mocked(beginActivitySubmission).mockImplementation(async (_auth, _project, id) => submitted(id))
  vi.mocked(recordSubmissionAssessment).mockImplementation(async (_auth, id) => ({ id, sourceCurrent: true }))
  vi.mocked(failActivitySubmission).mockResolvedValue(undefined)
  vi.mocked(generateText).mockResolvedValue({ output: { qualityScore: 17, feedback: ['Clear implementation.'] } } as Awaited<ReturnType<typeof generateText>>)
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.resetAllMocks() })

describe('verification deadlines', () => {
  it.each(['auth', 'project', 'activity', 'sandbox', 'minute', 'day', 'bot'] as const)('bounds a stalled %s check and stops late continuation', async stage => {
    vi.useFakeTimers()
    let finish!: (value: never) => void
    const pending = new Promise<never>(resolve => { finish = resolve })
    const value = stage === 'auth' ? { user: { id: 'test-user' } }
      : stage === 'project' ? { id: projectId, activity_id: activity.id, language: activity.language }
        : stage === 'activity' ? activity : stage === 'sandbox' ? { project_id: projectId }
          : stage === 'bot' ? { isBot: false } : {}
    if (stage === 'auth') vi.mocked(requireUser).mockReturnValueOnce(pending)
    if (stage === 'project') vi.mocked(requireOwnedProject).mockReturnValueOnce(pending)
    if (stage === 'activity') vi.mocked(findOwnedActivity).mockReturnValueOnce(pending)
    if (stage === 'sandbox') vi.mocked(requireOwnedSandboxRecord).mockReturnValueOnce(pending)
    if (stage === 'minute') vi.mocked(consumeQuota).mockReturnValueOnce(pending)
    if (stage === 'day') vi.mocked(consumeQuota).mockResolvedValueOnce({} as never).mockReturnValueOnce(pending)
    if (stage === 'bot') vi.mocked(checkBotId).mockReturnValueOnce(pending)
    let response: Response | undefined
    const run = POST(request()).then(value => { response = value })
    await vi.advanceTimersByTimeAsync(150_001)
    expect(response?.status).toBe(408)
    finish(value as never)
    await vi.advanceTimersByTimeAsync(1)
    await run
    expect(generateText).not.toHaveBeenCalled()
    expect(recordSubmissionAssessment).not.toHaveBeenCalled()
    if (stage !== 'bot') expect(beginActivitySubmission).not.toHaveBeenCalled()
  })

  it('bounds the final assessment receipt without claiming its write was rolled back', async () => {
    vi.useFakeTimers()
    let finish!: (value: { id: string; sourceCurrent: boolean }) => void
    vi.mocked(recordSubmissionAssessment).mockReturnValue(new Promise(resolve => { finish = resolve }))
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    let response: Response | undefined
    const run = POST(request()).then(value => { response = value })
    await vi.advanceTimersByTimeAsync(150_001)
    expect(response?.status).toBe(408)
    expect(await response!.json()).toMatchObject({ error: { message: expect.stringContaining('already-saved assessment is retained') } })
    finish({ id: vi.mocked(recordSubmissionAssessment).mock.calls[0][1], sourceCurrent: true })
    await vi.advanceTimersByTimeAsync(1)
    await run
    expect(recordSubmissionAssessment).toHaveBeenCalledOnce()
    expect(log.mock.calls.some(([, fields]) => fields?.outcome === 'complete')).toBe(false)
  })

  it('does not save a trusted grade returned after cancellation', async () => {
    const exercise = trustedDSAActivity(TRUSTED_DSA_IDS[0])
    vi.mocked(findOwnedActivity).mockResolvedValue(exercise)
    vi.mocked(requireOwnedProject).mockResolvedValue({ id: projectId, activity_id: exercise.id, language: 'JavaScript' } as never)
    const controller = new AbortController()
    vi.mocked(gradeDSASubmission).mockImplementation(async () => {
      controller.abort()
      return { score: 100, passed: true, aiAssessed: false, requestId: 'test', submissionId: crypto.randomUUID(), sourceDigest: 'a'.repeat(64), commandOutput: '', feedback: [] }
    })
    const response = await POST(request({ ...body, activityId: exercise.id }, controller.signal))
    expect(response.status).toBe(408)
    expect(recordSubmissionAssessment).not.toHaveBeenCalled()
    expect(checkBotId).not.toHaveBeenCalled()
    expect(generateText).not.toHaveBeenCalled()
  })
  it('bounds a provider that ignores cancellation and never saves its late score', async () => {
    vi.useFakeTimers()
    let finish!: (value: Awaited<ReturnType<typeof generateText>>) => void
    vi.mocked(generateText).mockReturnValue(new Promise(resolve => { finish = resolve }))
    let response: Response | undefined
    const run = POST(request()).then(value => { response = value })
    await vi.advanceTimersByTimeAsync(60_001)
    expect(response?.status).toBe(408)
    expect(vi.mocked(generateText).mock.calls[0][0].abortSignal?.aborted).toBe(true)
    expect(recordSubmissionAssessment).not.toHaveBeenCalled()
    finish({ output: { qualityScore: 20, feedback: ['Late result'] } } as Awaited<ReturnType<typeof generateText>>)
    await vi.advanceTimersByTimeAsync(1)
    await run
    expect(recordSubmissionAssessment).not.toHaveBeenCalled()
    expect(failActivitySubmission).toHaveBeenCalledWith(expect.anything(), expect.any(String), 'SUBMISSION_INTERRUPTED')
  })

  it('does not start a provider from a submission receipt arriving after the request deadline', async () => {
    vi.useFakeTimers()
    let finish!: (value: ReturnType<typeof submitted>) => void
    vi.mocked(beginActivitySubmission).mockReturnValue(new Promise(resolve => { finish = resolve }))
    let response: Response | undefined
    const run = POST(request()).then(value => { response = value })
    await vi.advanceTimersByTimeAsync(150_001)
    expect(response?.status).toBe(408)
    const id = vi.mocked(beginActivitySubmission).mock.calls[0][2]
    finish(submitted(id))
    await vi.advanceTimersByTimeAsync(1)
    await run
    expect(generateText).not.toHaveBeenCalled()
    expect(recordSubmissionAssessment).not.toHaveBeenCalled()
    // The first failure receipt may precede creation; settle a late creation too.
    expect(failActivitySubmission).toHaveBeenCalledTimes(2)
  })

  it('bounds failed-submission cleanup even if the database ignores cancellation', async () => {
    vi.useFakeTimers()
    vi.mocked(generateText).mockRejectedValue(new Error('private provider failure'))
    vi.mocked(failActivitySubmission).mockReturnValue(new Promise(() => {}))
    let response: Response | undefined
    const run = POST(request()).then(value => { response = value })
    await vi.advanceTimersByTimeAsync(5_001)
    expect(response?.status).toBe(502)
    await run
    expect(recordSubmissionAssessment).not.toHaveBeenCalled()
  })
})

describe('immutable activity verification', () => {
  it('rejects automated AI review before calling the provider and retains a failed submission', async () => {
    vi.mocked(checkBotId).mockResolvedValue({ isBot: true } as Awaited<ReturnType<typeof checkBotId>>)
    const response = await POST(request())
    expect(response.status).toBe(403)
    expect(generateText).not.toHaveBeenCalled()
    expect(recordSubmissionAssessment).not.toHaveBeenCalled()
    expect(failActivitySubmission).toHaveBeenCalledWith(expect.anything(), expect.any(String), 'BOT_DETECTED')
  })

  it.each([undefined, { qualityScore: 21, feedback: ['Bad grade'] }, { qualityScore: 14.5, feedback: ['Bad grade'] }, { qualityScore: 20, feedback: [] }])('rejects malformed rubric output without a score: %j', async output => {
    vi.mocked(generateText).mockResolvedValue({ output } as Awaited<ReturnType<typeof generateText>>)
    const response = await POST(request())
    expect(response.status).toBe(502)
    expect(recordSubmissionAssessment).not.toHaveBeenCalled()
    expect(failActivitySubmission).toHaveBeenCalledWith(expect.anything(), expect.any(String), 'RUBRIC_UNAVAILABLE')
  })

  it('uses bounded provider output, disables automatic retries, and logs only identifiers and timings', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const response = await POST(request({ ...body, reflection: 'private learner reflection' }))
    expect(response.status).toBe(200)
    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({ maxRetries: 0, maxOutputTokens: 4096, abortSignal: expect.any(AbortSignal) }))
    expect(log.mock.calls).toHaveLength(2)
    for (const [label, fields] of log.mock.calls) {
      expect(label).toBe('Verification lifecycle')
      expect(Object.keys(fields).sort()).toEqual(['durationMs', 'outcome', 'requestId'])
    }
    expect(JSON.stringify(log.mock.calls)).not.toContain('private learner reflection')
  })
  it.each(TRUSTED_CHALLENGE_IDS)('grades %s with server checks and assessment quotas, never AI', async id => {
    const exercise=trustedChallengeActivity(id)
    vi.mocked(findOwnedActivity).mockResolvedValue(exercise)
    vi.mocked(requireOwnedProject).mockResolvedValue({id:projectId,activity_id:id,language:exercise.language} as never)
    vi.mocked(beginActivitySubmission).mockImplementation(async (_auth,_project,submissionId)=>({...submitted(submissionId),manifest:exercise,language:exercise.language}))
    vi.mocked(gradeChallengeSubmission).mockImplementation(async (_auth,_sandbox,submission)=>({score:100,passed:true,aiAssessed:false,feedback:['24/24 checks passed'],requestId:submission.id,submissionId:submission.id,sourceDigest:submission.digest,commandOutput:'Trusted checks'}))
    const response=await POST(request({...body,activityId:id}))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({score:100,passed:true,aiAssessed:false,sourceCurrent:true})
    expect(gradeChallengeSubmission).toHaveBeenCalledOnce()
    expect(gradeDSASubmission).not.toHaveBeenCalled()
    expect(generateText).not.toHaveBeenCalled()
    expect(consumeQuota).toHaveBeenCalledWith('test-user','assessment-minute')
    expect(consumeQuota).toHaveBeenCalledWith('test-user','assessment-day')
    expect(consumeQuota).not.toHaveBeenCalledWith('test-user','ai-minute')
  })
  it.each(['GRADING_RUNTIME_UNAVAILABLE','GRADING_RESULT_INVALID','GRADING_ENVIRONMENT_OUTDATED'])('does not fall back to AI after Challenge %s',async code=>{
    const exercise=trustedChallengeActivity('challenge-java-transform')
    vi.mocked(findOwnedActivity).mockResolvedValue(exercise)
    vi.mocked(requireOwnedProject).mockResolvedValue({id:projectId,activity_id:exercise.id,language:exercise.language} as never)
    vi.mocked(gradeChallengeSubmission).mockRejectedValue(new ApiError(502,code,'No score saved'))
    expect((await POST(request({...body,activityId:exercise.id}))).status).toBe(502)
    expect(generateText).not.toHaveBeenCalled()
    expect(recordSubmissionAssessment).not.toHaveBeenCalled()
    expect(failActivitySubmission).toHaveBeenCalledWith(expect.anything(),expect.any(String),code)
  })
  it.each(TRUSTED_DSA_IDS.flatMap(id => DSA_LANGUAGES.map(language => [id, language] as const)))('routes %s/%s to trusted grading without AI credits', async (id, language) => {
    const exercise = trustedDSAActivity(id)
    vi.mocked(findOwnedActivity).mockResolvedValue(exercise)
    vi.mocked(requireOwnedProject).mockResolvedValue({ id: projectId, activity_id: exercise.id, language } as never)
    vi.mocked(beginActivitySubmission).mockImplementation(async (_auth, _project, id) => ({ ...submitted(id), manifest: exercise, language,
      files: [{ path: dsaEntryPath(language), content: 'saved source fixture' }] }))
    vi.mocked(gradeDSASubmission).mockImplementation(async (_auth, _sandbox, submission) => ({ score: 100, passed: true, aiAssessed: false,
      feedback: ['24/24 checks passed'], requestId: submission.id, submissionId: submission.id, sourceDigest: submission.digest, commandOutput: 'Trusted checks' }))
    const response = await POST(request({ ...body, activityId: exercise.id }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ score: 100, passed: true, aiAssessed: false, sourceCurrent: true })
    expect(generateText).not.toHaveBeenCalled()
    expect(consumeQuota).toHaveBeenCalledWith('test-user', 'assessment-minute')
    expect(consumeQuota).not.toHaveBeenCalledWith('test-user', 'ai-day')
    expect(gradeDSASubmission).toHaveBeenCalledOnce()
    expect(gradeDSASubmission).toHaveBeenCalledWith(expect.anything(), body.sandboxId,
      expect.objectContaining({ language, manifest: exercise }), expect.any(AbortSignal))
    expect(recordSubmissionAssessment).toHaveBeenCalledWith(expect.anything(), expect.any(String), expect.objectContaining({ aiAssessed: false }))
  })
  it.each(['GRADING_RUNTIME_UNAVAILABLE', 'GRADING_RESULT_INVALID'])('never turns a trusted runner failure (%s) into AI points', async code => {
    const exercise = foundationDSAActivity('dsa-python-two-sum')
    vi.mocked(findOwnedActivity).mockResolvedValue(exercise)
    vi.mocked(requireOwnedProject).mockResolvedValue({ id: projectId, activity_id: exercise.id, language: 'JavaScript' } as never)
    vi.mocked(gradeDSASubmission).mockRejectedValue(new ApiError(502, code, 'No score saved'))
    expect((await POST(request({ ...body, activityId: exercise.id }))).status).toBe(502)
    expect(generateText).not.toHaveBeenCalled()
    expect(recordSubmissionAssessment).not.toHaveBeenCalled()
    expect(failActivitySubmission).toHaveBeenCalledWith(expect.anything(), expect.any(String), code)
  })
  it('retains source without a score when service credits are exhausted', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(generateText).mockRejectedValue(new GatewayInternalServerError({ statusCode: 402, message: 'private-provider-details' }))
    const response = await POST(request())
    expect(response.status).toBe(503)
    const body = await response.json()
    expect(body.error.code).toBe('AI_CREDITS_EXHAUSTED')
    expect(body.error.message).toContain('retained without a score')
    expect(JSON.stringify(body)).not.toContain('private-provider')
    expect(recordSubmissionAssessment).not.toHaveBeenCalled()
    expect(failActivitySubmission).toHaveBeenCalledWith(expect.anything(), expect.any(String), 'AI_CREDITS_EXHAUSTED')
    log.mockRestore()
  })
  it('assesses a retained saved-source version without opening an expired VM or running editable tests', async () => {
    const response = await POST(request())
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(response.headers.get('x-ratelimit-limit')).toBe('10')
    const result = await response.json()
    expect(result).toMatchObject({ score: 85, passed: true, aiAssessed: true, sourceCurrent: true, sourceDigest: 'a'.repeat(64) })
    expect(result.submissionId).toBe(result.requestId)
    expect(runOwnedCommand).not.toHaveBeenCalled()
    expect(getOwnedSandbox).not.toHaveBeenCalled()
    expect(JSON.parse(String(vi.mocked(generateText).mock.calls[0][0].prompt)).sourceEvidence).toContain('export const solve')
    expect(recordSubmissionAssessment).toHaveBeenCalledOnce()
    expect(failActivitySubmission).not.toHaveBeenCalled()
  })
  it('retains a failed attempt without a learner score when AI is unavailable', async () => {
    vi.mocked(generateText).mockRejectedValue(new Error('Provider error: private diagnostic'))
    const response = await POST(request())
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ error: { code: 'RUBRIC_UNAVAILABLE' } })
    expect(recordSubmissionAssessment).not.toHaveBeenCalled()
    expect(failActivitySubmission).toHaveBeenCalledWith(expect.anything(), expect.any(String), 'RUBRIC_UNAVAILABLE')
  })
  it('does not persist a score after cancellation during the AI call', async () => {
    const controller = new AbortController()
    vi.mocked(generateText).mockImplementation(async () => { controller.abort(); throw controller.signal.reason })
    expect((await POST(request(body, controller.signal))).status).toBe(408)
    expect(recordSubmissionAssessment).not.toHaveBeenCalled()
    expect(failActivitySubmission).toHaveBeenCalledWith(expect.anything(), expect.any(String), 'SUBMISSION_INTERRUPTED')
  })
  it('requires durable assessment persistence before returning success', async () => {
    vi.mocked(recordSubmissionAssessment).mockRejectedValue(new ApiError(409, 'SUBMISSION_CLOSED', 'Reopen history.'))
    expect((await POST(request())).status).toBe(409)
  })
  it.each([{ ...body, files: [] }, { ...body, generatedActivity: activity }, { ...body, modelId: 'fake/model' }, { ...body, projectId: 'invalid' }])('rejects client-authored source, activity and invalid fields', async (input) => {
    expect((await POST(request(input))).status).toBe(400)
    expect(beginActivitySubmission).not.toHaveBeenCalled()
  })
  it('rejects a different activity or project sandbox before creating evidence', async () => {
    expect((await POST(request({ ...body, activityId: 'another-activity' }))).status).toBe(409)
    vi.mocked(requireOwnedSandboxRecord).mockResolvedValue({ project_id: 'another-project' } as Awaited<ReturnType<typeof requireOwnedSandboxRecord>>)
    expect((await POST(request())).status).toBe(404)
    expect(beginActivitySubmission).not.toHaveBeenCalled()
  })
  it('rejects another user before reading any submission evidence', async () => {
    vi.mocked(requireUser).mockRejectedValue(new ApiError(401, 'AUTH_REQUIRED', 'Sign in.'))
    expect((await POST(request())).status).toBe(401)
    expect(beginActivitySubmission).not.toHaveBeenCalled()
  })
  it('never awards automatic points because the manifest has a run command', async () => {
    vi.mocked(generateText).mockResolvedValue({ output: { qualityScore: 0, feedback: ['The implementation is missing.'] } } as Awaited<ReturnType<typeof generateText>>)
    expect(await (await POST(request())).json()).toMatchObject({ score: 0, passed: false, aiAssessed: true })
    expect(runOwnedCommand).not.toHaveBeenCalled()
  })
  it.each([{ files: [] }, { files: [{ path: 'main.js', content: '  ' }] }, { files: [{ path: 'another.js', content: 'code' }] }])('does not assess missing or empty immutable source', async ({ files }) => {
    vi.mocked(beginActivitySubmission).mockResolvedValue({ ...submitted(), files })
    expect((await POST(request())).status).toBe(409)
    expect(generateText).not.toHaveBeenCalled()
    expect(recordSubmissionAssessment).not.toHaveBeenCalled()
  })
  it('retains oversized evidence without silently assessing a truncated prefix', async () => {
    vi.mocked(beginActivitySubmission).mockResolvedValue({ ...submitted(), files: [{ path: 'main.js', content: 'x'.repeat(64_001) }] })
    expect((await POST(request())).status).toBe(413)
    expect(generateText).not.toHaveBeenCalled()
    expect(recordSubmissionAssessment).not.toHaveBeenCalled()
  })
  it('returns the original assessment with a warning when saved source has advanced', async () => {
    vi.mocked(recordSubmissionAssessment).mockImplementation(async (_auth, id) => ({ id, sourceCurrent: false }))
    const response = await POST(request())
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ passed: true, score: 85, sourceCurrent: false })
    expect(beginActivitySubmission).toHaveBeenCalledOnce()
  })
  it.each(['SOURCE_CAPTURE_PENDING', 'SOURCE_REVIEW_REQUIRED', 'SUBMISSION_STORAGE_LIMIT'])('does not call the provider when capture or storage prevents a submission', async (code) => {
    vi.mocked(beginActivitySubmission).mockRejectedValue(new ApiError(code === 'SUBMISSION_STORAGE_LIMIT' ? 429 : 409, code, 'Wait or review your source.'))
    expect((await POST(request())).status).toBe(code === 'SUBMISSION_STORAGE_LIMIT' ? 429 : 409)
    expect(generateText).not.toHaveBeenCalled()
  })
})
