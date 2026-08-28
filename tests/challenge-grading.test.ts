import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {createHash} from 'node:crypto'
import {gradeChallengeSubmission} from '@/lib/server/challenge-grading'
import {trustedChallengeActivity} from '@/lib/learning/challenges/contracts'
import {runOwnedCommand} from '@/lib/server/owned-command'
import {prepareGradingEvidence,finishGradingEvidence} from '@/lib/server/grading-evidence'
import {expectedChallengeResult} from '@/lib/server/challenge-cases'
import type {ActivitySubmission} from '@/lib/server/activity-submissions'

vi.mock('server-only',()=>({}))
vi.mock('@/lib/server/owned-command',()=>({runOwnedCommand:vi.fn()}))
vi.mock('@/lib/server/grading-evidence',()=>({prepareGradingEvidence:vi.fn(),finishGradingEvidence:vi.fn()}))
const submission=():ActivitySubmission=>({id:crypto.randomUUID(),project_id:crypto.randomUUID(),user_id:crypto.randomUUID(),source_id:crypto.randomUUID(),source_versions:[{path:'src/main.mjs',revision:1}],manifest:trustedChallengeActivity('challenge-javascript-performance'),language:'JavaScript',model_id:'openai/gpt-5-nano',reflection:'',state:'pending',expires_at:new Date(Date.now()+60000).toISOString(),digest:'a'.repeat(64),files:[{path:'src/main.mjs',content:'saved entry'},{path:'tests.mjs',content:'forged passing tests'}]})
beforeEach(()=>{vi.mocked(prepareGradingEvidence).mockImplementation(async(_auth,id)=>({submissionId:id,planDigest:'b'.repeat(64),caseCount:24}))})
afterEach(()=>vi.resetAllMocks())

it('retains private Challenge evidence before awarding points and ignores editable tests',async()=>{
  const source=submission()
  vi.mocked(runOwnedCommand).mockImplementation(async(_auth,_sandbox,_input,options)=>{
    const plan=vi.mocked(prepareGradingEvidence).mock.calls[0][2]
    expect(plan).toMatchObject({checkVersion:'challenges-v1',activityId:source.manifest.id,sourceDigest:source.digest})
    expect(plan.cases).toHaveLength(24)
    const {payload,digest}=options.trustedAssessment!
    expect(digest).toBe(createHash('sha256').update(payload).digest('hex'))
    expect(JSON.parse(payload).files).toHaveLength(2)
    expect(payload).not.toContain('forged passing tests')
    expect(options).toMatchObject({requestId:source.id,projectId:source.project_id,origin:'verification'})
    return {exitCode:0,outputTruncated:false,output:JSON.stringify({compileFailure:null,cases:plan.cases.map(test=>({output:JSON.stringify(expectedChallengeResult('challenge-javascript-performance',test.input as never)),failure:null}))})} as never
  })
  const result=await gradeChallengeSubmission({} as never,'owned-sandbox',source,new AbortController().signal)
  expect(finishGradingEvidence).toHaveBeenCalledOnce()
  expect(result).toMatchObject({score:100,passed:true,aiAssessed:false})
  expect(result).not.toHaveProperty('report')
  expect(result).not.toHaveProperty('cases')
})
it.each(['generated','mismatched-language','unknown-id'])('rejects %s before any paid work',async mismatch=>{
  const source=submission()
  if(mismatch==='generated')source.manifest.source='generated'
  if(mismatch==='mismatched-language')source.language='Java'
  if(mismatch==='unknown-id')source.manifest.id='challenge-javascript-unknown'
  await expect(gradeChallengeSubmission({} as never,'sbx',source,new AbortController().signal)).rejects.toMatchObject({code:'GRADING_UNSUPPORTED'})
  expect(runOwnedCommand).not.toHaveBeenCalled()
  expect(prepareGradingEvidence).not.toHaveBeenCalled()
})
it.each(['plan','report'])('does not award a score when the %s cannot be retained',async stage=>{
  if(stage==='plan')vi.mocked(prepareGradingEvidence).mockRejectedValue(new Error('No durable plan'))
  else {vi.mocked(runOwnedCommand).mockResolvedValue({exitCode:0,outputTruncated:false,output:JSON.stringify({compileFailure:'execution-error',cases:[]})} as never);vi.mocked(finishGradingEvidence).mockRejectedValue(new Error('No durable report'))}
  await expect(gradeChallengeSubmission({} as never,'sbx',submission(),new AbortController().signal)).rejects.toThrow(stage==='plan'?'No durable plan':'No durable report')
  if(stage==='plan')expect(runOwnedCommand).not.toHaveBeenCalled()
})
it('does not dispatch after cancellation or silently score incomplete results',async()=>{
  const controller=new AbortController();controller.abort()
  await expect(gradeChallengeSubmission({} as never,'sbx',submission(),controller.signal)).rejects.toMatchObject({name:'AbortError'})
  expect(runOwnedCommand).not.toHaveBeenCalled()
  vi.mocked(runOwnedCommand).mockResolvedValue({exitCode:0,outputTruncated:false,output:'{"compileFailure":null,"cases":[]}'} as never)
  await expect(gradeChallengeSubmission({} as never,'sbx',submission(),new AbortController().signal)).rejects.toMatchObject({code:'GRADING_RESULT_INVALID'})
  expect(finishGradingEvidence).not.toHaveBeenCalled()
})
