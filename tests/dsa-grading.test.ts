import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DSA_LANGUAGES, FOUNDATION_DSA_IDS, foundationDSAActivity } from '@/lib/learning/dsa-foundations'
import { activityManifestSchema } from '@/lib/learning/types'
import { dsaCases, judgeDSAResult } from '@/lib/server/dsa-cases'
import { dsaPayload, gradeDSASubmission, scoreDSARun } from '@/lib/server/dsa-grading'
import { runOwnedCommand } from '@/lib/server/owned-command'
import { stopDSAGrading, trustedDSACommand } from '@/lib/sandbox/dsa-invocation'
import { dsaSolutions } from './fixtures/dsa-solutions'
import type { ActivitySubmission } from '@/lib/server/activity-submissions'
import type { AuthContext } from '@/lib/server/api'
import { createHash } from 'node:crypto'
import { prepareGradingEvidence, finishGradingEvidence } from '@/lib/server/grading-evidence'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/server/owned-command', () => ({ runOwnedCommand: vi.fn() }))
vi.mock('@/lib/server/grading-evidence', () => ({ prepareGradingEvidence: vi.fn(), finishGradingEvidence: vi.fn() }))
beforeEach(() => {
  vi.mocked(prepareGradingEvidence).mockImplementation(async (_auth, submissionId) => ({ submissionId, planDigest: 'd'.repeat(64), caseCount: 24 }))
})
afterEach(() => vi.resetAllMocks())

it.each(FOUNDATION_DSA_IDS)('ships precise examples and untouched failing starters for %s', id => {
  const activity = foundationDSAActivity(id)
  expect(activityManifestSchema.safeParse(activity).success).toBe(true)
  expect(activity.instructions.join(' ')).toContain('Trusted checks')
  expect(activity.examples).toHaveLength(3)
  for (const language of DSA_LANGUAGES) expect(activity.variants![language].starterFiles[0].content).toContain('Complete the TODO')
})

it.each(FOUNDATION_DSA_IDS)('checks all generated cases using an independent reference for %s', async id => {
  const { solve } = await import(`data:text/javascript;base64,${Buffer.from(dsaSolutions[id].JavaScript).toString('base64')}`)
  for (let trial = 0; trial < 8; trial++) {
    const cases = dsaCases(id)
    expect(cases).toHaveLength(24)
    const outputs = cases.map(test => ({ output: JSON.stringify(solve(structuredClone(test.input))), failure: null }))
    expect(scoreDSARun(id, cases, { compileFailure: null, cases: outputs })).toMatchObject({ score: 100, passed: true })
  }
})

it('accepts alternate valid pairs but rejects index reuse, forged scores and invalid output types', () => {
  const id = 'dsa-python-two-sum', input = { nums: [1, 2, 3, 2], target: 4 }
  expect(judgeDSAResult(id, input, [2, 0])).toBe(true)
  expect(judgeDSAResult(id, input, [1, 3])).toBe(true)
  for (const actual of [[1, 1], [0, 99], ['0', 2], [], [0, 1], { score: 100, passed: true }]) expect(judgeDSAResult(id, input, actual)).toBe(false)
  expect(judgeDSAResult(id, { nums: [3], target: 6 }, [])).toBe(true)
})

it('rejects a merely balanced count and requires the first binary-search duplicate', () => {
  expect(judgeDSAResult('dsa-python-valid-parentheses', '([)]', true)).toBe(false)
  expect(judgeDSAResult('dsa-python-valid-parentheses', '', true)).toBe(true)
  expect(judgeDSAResult('dsa-python-valid-parentheses', '()', 'true')).toBe(false)
  const input = { nums: [-1, 2, 2, 2, 5], target: 2 }
  expect(judgeDSAResult('dsa-python-binary-search', input, 2)).toBe(false)
  expect(judgeDSAResult('dsa-python-binary-search', input, 1)).toBe(true)
})

it('does not grant completion for partial checks, forged pass messages or a compile-only success', () => {
  const id = 'dsa-python-valid-parentheses', cases = dsaCases(id)
  const outputs = cases.map(test => ({ output: JSON.stringify(judgeDSAResult(id, test.input, true)), failure: null as string | null }))
  outputs[0] = { output: '{"passed":true,"score":100}', failure: null }
  expect(scoreDSARun(id, cases, { compileFailure: null, cases: outputs })).toMatchObject({ passed: false })
  outputs[0] = { output: '', failure: 'timeout' }
  expect(scoreDSARun(id, cases, { compileFailure: null, cases: outputs })).toMatchObject({ passed: false })
  expect(scoreDSARun(id, cases, { compileFailure: 'execution-error', cases: [] })).toMatchObject({ score: 0, passed: false })
  expect(() => scoreDSARun(id, cases, { compileFailure: null, cases: [] })).toThrow('complete evidence')
})

it.each(DSA_LANGUAGES)('sends only the submitted entry and fixed harness, not expected answers or mutable tests (%s)', language => {
  const cases = dsaCases('dsa-python-two-sum')
  const payload = dsaPayload('dsa-python-two-sum', language, 'submitted source', cases)
  expect(payload.files).toHaveLength(2)
  expect(payload.files[0].content).toBe('submitted source')
  expect(Object.keys(payload)).toEqual(['files', 'inputs', 'language'])
  expect(payload.inputs).toHaveLength(24)
  expect(JSON.stringify(payload)).not.toContain('expected')
})

it('never interpolates a payload reference into privileged executable text', () => {
  expect(() => trustedDSACommand('/etc/passwd', 'a'.repeat(64))).toThrow()
  const value = trustedDSACommand('/tmp/.codetutor-grade-550e8400-e29b-41d4-a716-446655440000.json', 'a'.repeat(64))
  expect(value.sudo).toBe(true)
  expect(value.args.slice(-2)).toEqual(['/tmp/.codetutor-grade-550e8400-e29b-41d4-a716-446655440000.json', 'a'.repeat(64)])
})

it.each(['/etc/passwd', '/tmp/.codetutor-grade-../../etc/passwd.json', '/tmp/.codetutor-grade-550e8400-e29b-41d4-a716-446655440000.json\n'])('rejects an invalid grading stop reference before accessing the VM: %s', async path => {
  const vm = { runCommand: vi.fn() }
  await expect(stopDSAGrading(vm, path, new AbortController().signal)).rejects.toThrow('Invalid grading payload reference')
  expect(vm.runCommand).not.toHaveBeenCalled()
})

it('does not treat a failed privileged stop as confirmed termination', async () => {
  const vm = { runCommand: vi.fn().mockResolvedValue({ exitCode: 75 }) }
  await expect(stopDSAGrading(vm, '/tmp/.codetutor-grade-550e8400-e29b-41d4-a716-446655440000.json', new AbortController().signal)).rejects.toThrow('termination could not be confirmed')
})

it('rejects generated look-alikes before dispatching paid execution', async () => {
  await expect(gradeDSASubmission({} as never, 'sbx', { manifest: { id: FOUNDATION_DSA_IDS[0], source: 'generated' }, language: 'Python' } as never, new AbortController().signal)).rejects.toMatchObject({ code: 'GRADING_UNSUPPORTED' })
  expect(runOwnedCommand).not.toHaveBeenCalled()
})

function submittedSource(): ActivitySubmission {
  return { id: crypto.randomUUID(), project_id: crypto.randomUUID(), user_id: crypto.randomUUID(),
    source_id: crypto.randomUUID(), source_versions: [{ path: 'src/main.mjs', revision: 2 }],
    manifest: foundationDSAActivity(FOUNDATION_DSA_IDS[0]), language: 'JavaScript', model_id: 'openai/gpt-5-nano',
    reflection: '', state: 'pending', expires_at: new Date(Date.now() + 60_000).toISOString(), digest: 'a'.repeat(64),
    files: [{ path: 'src/main.mjs', content: dsaSolutions[FOUNDATION_DSA_IDS[0]].JavaScript }],
  }
}

it('never creates a passing or NaN score without a bounded nonempty case set', () => {
  expect(() => scoreDSARun(FOUNDATION_DSA_IDS[0], [], { compileFailure: null, cases: [] })).toThrow('complete evidence')
})

it.each([
  ['GRADING_WORKSPACE_BUSY', 409, 'GRADING_WORKSPACE_BUSY'],
  ['GRADING_TOOLCHAIN_UNAVAILABLE', 409, 'GRADING_ENVIRONMENT_OUTDATED'],
  ['SANDBOX_CLOSING', 409, 'SANDBOX_CLOSING'],
  ['GRADING_ISOLATION_UNAVAILABLE', 502, 'GRADING_RUNTIME_UNAVAILABLE'],
  ['GRADING_TOOLCHAIN_UNSAFE', 502, 'GRADING_RUNTIME_UNAVAILABLE'],
] as const)('keeps %s as an unscored recoverable failure', async (failure, status, code) => {
  vi.mocked(runOwnedCommand).mockResolvedValue({ output: JSON.stringify({ error: failure }), exitCode: 1, outputTruncated: false } as never)
  await expect(gradeDSASubmission({} as AuthContext, 'sbx_test', submittedSource(), new AbortController().signal))
    .rejects.toMatchObject({ status, code })
})

it.each([
  { output: '{}', exitCode: 0, outputTruncated: true },
  { output: '<html>upstream failure</html>', exitCode: 0, outputTruncated: false },
  { output: '{"compileFailure":null,"cases":[]}', exitCode: 0, outputTruncated: false },
])('retains unscored submissions when evidence is truncated, unreadable or incomplete', async (result) => {
  vi.mocked(runOwnedCommand).mockResolvedValue(result as never)
  await expect(gradeDSASubmission({} as AuthContext, 'sbx_test', submittedSource(), new AbortController().signal))
    .rejects.toMatchObject({ code: 'GRADING_RESULT_INVALID' })
})

it('rejects missing source and pre-cancelled submissions without dispatch', async () => {
  const submission = submittedSource()
  await expect(gradeDSASubmission({} as AuthContext, 'sbx_test', { ...submission, files: [] }, new AbortController().signal))
    .rejects.toMatchObject({ code: 'SUBMISSION_SOURCE_MISSING' })
  const controller = new AbortController()
  controller.abort()
  await expect(gradeDSASubmission({} as AuthContext, 'sbx_test', submission, controller.signal))
    .rejects.toMatchObject({ name: 'AbortError' })
  expect(runOwnedCommand).not.toHaveBeenCalled()
})

it('binds the immutable payload, digest and cancellation to the owned submission', async () => {
  const submission = submittedSource(), controller = new AbortController()
  vi.mocked(runOwnedCommand).mockImplementation(async (auth, sandboxId, input, options) => {
    expect(auth).toMatchObject({ user: { id: submission.user_id } })
    expect(sandboxId).toBe('sbx_test')
    expect(input).toEqual({ executable: 'python3', args: [] })
    expect(options).toMatchObject({ projectId: submission.project_id, requestId: submission.id, origin: 'verification', signal: controller.signal })
    const { payload, digest } = options.trustedAssessment!
    expect(digest).toBe(createHash('sha256').update(payload).digest('hex'))
    expect(JSON.parse(payload).files[0].content).toBe(submission.files[0].content)
    controller.abort()
    return { output: '{}', exitCode: 0, outputTruncated: false } as never
  })
  await expect(gradeDSASubmission({ user: { id: submission.user_id } } as AuthContext, 'sbx_test', submission, controller.signal))
    .rejects.toMatchObject({ name: 'AbortError' })
})

it('acknowledges the plan before execution and retains each judged output before returning a score', async () => {
  const submission = submittedSource(), auth = { user: { id: submission.user_id } } as AuthContext
  vi.mocked(runOwnedCommand).mockImplementation(async (_auth, _sandbox, _input, options) => {
    expect(prepareGradingEvidence).toHaveBeenCalledOnce()
    const plan = vi.mocked(prepareGradingEvidence).mock.calls[0][2]
    const payload = JSON.parse(options.trustedAssessment!.payload)
    expect(plan.sourceDigest).toBe(submission.digest)
    expect(plan.cases.map(test => JSON.stringify(test.input))).toEqual(payload.inputs)
    expect(plan.harnessDigest).toBe(createHash('sha256').update(JSON.stringify(payload.files.slice(1))).digest('hex'))
    expect(plan.runtimeDigest).toMatch(/^[a-f0-9]{64}$/)
    const { solve } = await import(`data:text/javascript;base64,${Buffer.from(submission.files[0].content).toString('base64')}`)
    return { output: JSON.stringify({ compileFailure: null, cases: plan.cases.map(test => ({ output: JSON.stringify(solve(structuredClone(test.input))), failure: null })) }), exitCode: 0, outputTruncated: false } as never
  })
  let finish!: () => void
  vi.mocked(finishGradingEvidence).mockReturnValue(new Promise(resolve => { finish = () => resolve(undefined as never) }))
  let returned = false
  const result = gradeDSASubmission(auth, 'sbx_test', submission, new AbortController().signal).then(value => { returned = true; return value })
  await vi.waitFor(() => expect(finishGradingEvidence).toHaveBeenCalledOnce())
  expect(returned).toBe(false)
  expect(finishGradingEvidence).toHaveBeenCalledWith(auth, submission.id, 'd'.repeat(64), {
    compileFailure: null, cases: expect.arrayContaining([expect.objectContaining({ passed: true, failure: null, output: expect.any(String) })]),
  }, expect.any(AbortSignal))
  expect(vi.mocked(finishGradingEvidence).mock.calls[0][3].cases).toHaveLength(24)
  finish()
  const value = await result
  expect(value).toMatchObject({ score: 100, passed: true, aiAssessed: false })
  expect(value).not.toHaveProperty('report')
  expect(value).not.toHaveProperty('cases')
})

it('does not execute a learner program when the durable plan cannot be confirmed', async () => {
  vi.mocked(prepareGradingEvidence).mockRejectedValue(new Error('Plan unavailable'))
  await expect(gradeDSASubmission({} as AuthContext, 'sbx', submittedSource(), new AbortController().signal)).rejects.toThrow('Plan unavailable')
  expect(runOwnedCommand).not.toHaveBeenCalled()
  expect(finishGradingEvidence).not.toHaveBeenCalled()
})

it('does not return a score when the result could not be retained', async () => {
  vi.mocked(runOwnedCommand).mockResolvedValue({ output: JSON.stringify({ compileFailure: 'execution-error', cases: [] }), exitCode: 0, outputTruncated: false } as never)
  vi.mocked(finishGradingEvidence).mockRejectedValue(new Error('Result unavailable'))
  await expect(gradeDSASubmission({} as AuthContext, 'sbx', submittedSource(), new AbortController().signal)).rejects.toThrow('Result unavailable')
  expect(finishGradingEvidence).toHaveBeenCalledOnce()
})
