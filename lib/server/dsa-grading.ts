import 'server-only'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { dsaEntryPath, isDSALanguage, type DSALanguage } from '@/lib/learning/dsa-foundations'
import { isTrustedDSAId, type TrustedDSAId } from '@/lib/learning/dsa'
import { isExtendedDSAId, type ExtendedDSAInput } from '@/lib/learning/dsa-extended'
import { extendedCompiledHarness } from './dsa-extended-harness'
import type { ActivitySubmission } from './activity-submissions'
import { ApiError, type AuthContext } from './api'
import { dsaCases, DSA_CHECK_VERSION, judgeDSAResult, type DSACase } from './dsa-cases'
import { runOwnedCommand } from './owned-command'
import { prepareGradingEvidence, finishGradingEvidence, type GradingReport } from './grading-evidence'
import { trustedDSACommand } from '@/lib/sandbox/dsa-invocation'

export function hasTrustedDSAGrader(id: string, language: string) { return isTrustedDSAId(id) && isDSALanguage(language) }

export function dsaPayload(id: TrustedDSAId, language: DSALanguage, source: string, cases: DSACase[]) {
  const brackets = id.endsWith('valid-parentheses'), pair = id.endsWith('two-sum')
  const entry = dsaEntryPath(language).split('/').at(-1)!
  const files = [{ path: entry, content: source }]
  let inputs = cases.map(test => JSON.stringify(test.input))
  if (language === 'JavaScript' || language === 'TypeScript') files.push({ path: 'runner.mjs', content:
    `import { readFileSync } from 'node:fs';\nimport { solve } from './${entry}';\nconst result = await solve(JSON.parse(readFileSync(0, 'utf8')));\nprocess.stdout.write(JSON.stringify(result));\n` })
  if (language === 'Python') files.push({ path: 'runner.py', content:
    `import importlib.util, json, os, sys\nspec=importlib.util.spec_from_file_location('solution',os.path.join(os.path.dirname(__file__),'main.py'))\nmodule=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(module)\nprint(json.dumps(module.solve(json.load(sys.stdin)), allow_nan=False))\n` })
  if (language === 'Java' || language === 'C++') {
    if (isExtendedDSAId(id)) {
      const harness = extendedCompiledHarness(id, language, cases.map(test => test.input as ExtendedDSAInput))
      return { files: [...files, harness.file], inputs: harness.inputs, language }
    }
    inputs = cases.map(({ input }) => typeof input === 'string' ? `${input}\n` : `${(input.nums as number[]).length} ${input.target}\n${(input.nums as number[]).join(' ')}\n`)
    const javaInput = brackets ? 'String value=new java.util.Scanner(System.in).nextLine();' : 'java.util.Scanner scanner=new java.util.Scanner(System.in); int n=scanner.nextInt(), target=scanner.nextInt(); int[] nums=new int[n]; for(int i=0;i<n;i++)nums[i]=scanner.nextInt();'
    const cppInput = brackets ? 'string value; getline(cin,value);' : 'int n,target; cin>>n>>target; vector<int> nums(n); for(auto &value:nums)cin>>value;'
    const args = brackets ? 'value' : 'nums,target'
    if (language === 'Java') files.push({ path: 'Runner.java', content: `public class Runner { public static void main(String[] args) { ${javaInput} System.out.print(${pair ? `java.util.Arrays.toString(Main.solve(${args}))` : `Main.solve(${args})`}); } }\n` })
    else files.push({ path: 'runner.cpp', content: `#include <iostream>\n#include "main.cpp"\nint main(){${cppInput} auto result=solve(${args}); ${pair ? 'cout<<"[";for(size_t i=0;i<result.size();i++){if(i)cout<<",";cout<<result[i];}cout<<"]";' : brackets ? 'cout<<(result?"true":"false");' : 'cout<<result;'} }\n` })
  }
  return { files, inputs, language }
}

const runnerResultSchema = z.object({ compileFailure: z.enum(['timeout','output-limit','execution-error','invalid-output']).nullable(),
  cases: z.array(z.object({ output: z.string().max(8192), failure: z.enum(['timeout','output-limit','execution-error','invalid-output']).nullable() }).strict()).max(24),
}).strict()

type Judge = (input: DSACase['input'], actual: unknown) => boolean

function assessRun(cases: DSACase[], value: unknown, judge: Judge, checkVersion: string) {
  const parsed = runnerResultSchema.safeParse(value)
  if (cases.length === 0 || cases.length > 24 || !parsed.success || (!parsed.data.compileFailure && parsed.data.cases.length !== cases.length)) throw new ApiError(502, 'GRADING_RESULT_INVALID', 'The runner did not return complete evidence. No score was saved.')
  if (parsed.data.compileFailure) return { score: 0, passed: false, feedback: ['The submitted program did not compile within the runner limits. Check its syntax and signature, then save and resubmit.'], report: { compileFailure: parsed.data.compileFailure, cases: [] } satisfies GradingReport }
  const report: GradingReport = { compileFailure: null, cases: [] }
  for (let index = 0; index < cases.length; index++) {
    const result = parsed.data.cases[index]
    let passed = false
    if (!result.failure) {
      try { passed = judge(cases[index].input, JSON.parse(result.output)) } catch { /* malformed output is not a result */ }
    }
    report.cases.push({ ...result, passed })
  }
  const passed = report.cases.filter(test => test.passed).length
  return { score: Math.floor(100 * passed / cases.length), passed: passed === cases.length,
    report,
    feedback: [`${passed}/${cases.length} server-controlled behavioral checks passed (${checkVersion}).`,
      passed === cases.length ? 'All checked outputs are correct. This does not prove time/space complexity; explain your invariant and complexity in your reflection.' : 'Review boundary inputs, duplicate values and the required return type. Save your changes before submitting again.'] }
}

export function scoreDSARun(id: TrustedDSAId, cases: DSACase[], value: unknown) {
  return scoreBehavioralRun(cases, value, (input, actual) => judgeDSAResult(id, input, actual), DSA_CHECK_VERSION)
}

export function scoreBehavioralRun(cases: DSACase[], value: unknown, judge: Judge, checkVersion: string) {
  const { score, passed, feedback } = assessRun(cases, value, judge, checkVersion)
  return { score, passed, feedback }
}

export async function gradeDSASubmission(auth: AuthContext, sandboxId: string, submission: ActivitySubmission, signal: AbortSignal) {
  signal.throwIfAborted()
  const id = submission.manifest.id, language = submission.language
  if (submission.manifest.source !== 'curated' || !isTrustedDSAId(id) || !isDSALanguage(language)) throw new ApiError(400, 'GRADING_UNSUPPORTED', 'No trusted runner is registered for this activity.')
  return gradeBehavioralSubmission(auth, sandboxId, submission, signal, {
    language, cases: dsaCases(id), checkVersion: DSA_CHECK_VERSION,
    payload: (source, cases) => dsaPayload(id, language, source, cases),
    judge: (input, actual) => judgeDSAResult(id, input, actual),
  })
}

/** Internal server-only protocol. Callers must first select an exact trusted
 * activity/language registration; client manifests never supply these functions. */
export async function gradeBehavioralSubmission(auth: AuthContext, sandboxId: string, submission: ActivitySubmission, signal: AbortSignal, grader: {
  language: DSALanguage; cases: DSACase[]; checkVersion: string;
  payload: (source: string, cases: DSACase[]) => ReturnType<typeof dsaPayload>; judge: Judge;
}) {
  signal.throwIfAborted()
  const { language, cases, checkVersion } = grader
  const id = submission.manifest.id
  const entry = submission.files.find(file => file.path === dsaEntryPath(language))
  if (!entry?.content.trim()) throw new ApiError(409, 'SUBMISSION_SOURCE_MISSING', 'Save the required solution file before submitting.')
  const input = grader.payload(entry.content, cases)
  const payload = JSON.stringify(input)
  const path = `/tmp/.codetutor-grade-${submission.id}.json`
  const digest = createHash('sha256').update(payload).digest('hex')
  const plan = await prepareGradingEvidence(auth, submission.id, {
    version: 1, checkVersion, activityId: id, language, sourceDigest: submission.digest, cases,
    harnessDigest: createHash('sha256').update(JSON.stringify(input.files.slice(1))).digest('hex'),
    runtimeDigest: createHash('sha256').update(JSON.stringify(trustedDSACommand('/tmp/.codetutor-grade-00000000-0000-0000-0000-000000000000.json', '0'.repeat(64)))).digest('hex'),
  }, signal)
  signal.throwIfAborted()
  const execution = await runOwnedCommand(auth, sandboxId, { executable: 'python3', args: [] }, {
    origin: 'verification', requestId: submission.id, projectId: submission.project_id, signal,
    trustedAssessment: { path, payload, digest },
  })
  signal.throwIfAborted()
  if (execution.outputTruncated) throw new ApiError(502, 'GRADING_RESULT_INVALID', 'Grading output exceeded its limit. No score was saved.')
  let output: unknown
  try { output = JSON.parse(execution.output) } catch { throw new ApiError(502, 'GRADING_RESULT_INVALID', 'The runner returned unreadable evidence. No score was saved.') }
  if (execution.exitCode !== 0) {
    const error = z.object({ error: z.string() }).safeParse(output)
    const code = error.success ? error.data.error : ''
    if (code === 'GRADING_WORKSPACE_BUSY') throw new ApiError(409, code, 'Stop running commands before grading this submission. Its saved source is retained.')
    if (code === 'GRADING_TOOLCHAIN_UNAVAILABLE') throw new ApiError(409, 'GRADING_ENVIRONMENT_OUTDATED', 'This sandbox predates the trusted grading environment. Save your work, stop this sandbox, then restore the project in a new sandbox. The submitted source is retained without a score.')
    if (code === 'SANDBOX_CLOSING') throw new ApiError(409, code, 'The sandbox is shutting down. Wait for the final source save, then restore the project before grading. The submitted source is retained without a score.')
    throw new ApiError(502, 'GRADING_RUNTIME_UNAVAILABLE', 'The isolated grading runtime could not run. No score was saved; the submitted source is retained.')
  }
  const { report, ...result } = assessRun(cases, output, grader.judge, checkVersion)
  await finishGradingEvidence(auth, submission.id, plan.planDigest, report, signal)
  // Only the safe score crosses the HTTP boundary. Inputs and outputs remain
  // in the private evidence store, including failed learner checks.
  return { ...result, aiAssessed: false, requestId: submission.id, submissionId: submission.id,
    sourceDigest: submission.digest, commandOutput: 'Trusted checks ran against the retained solution file in an isolated process. Learner-owned test files and package scripts were not executed.' }
}
