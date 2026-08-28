import 'server-only'
import { challengeContracts, challengeKind, challengeLanguage, hasTrustedChallengeGrader, isTrustedChallengeId, type TrustedChallengeId } from '@/lib/learning/challenges/contracts'
import { dsaEntryPath } from '@/lib/learning/dsa-foundations'
import type { ExtendedDSAInput } from '@/lib/learning/dsa-extended'
import { ApiError, type AuthContext } from './api'
import type { ActivitySubmission } from './activity-submissions'
import type { DSACase } from './dsa-cases'
import { compiledHarness } from './dsa-extended-harness'
import { gradeBehavioralSubmission, scoreBehavioralRun } from './dsa-grading'
import { challengeCases, CHALLENGE_CHECK_VERSION, judgeChallengeResult } from './challenge-cases'

export function challengePayload(id:TrustedChallengeId,source:string,cases:DSACase[]) {
  const language=challengeLanguage(id),entry=dsaEntryPath(language).split('/').at(-1)!
  const files=[{path:entry,content:source}]
  if(language==='Java'||language==='C++'){
    const harness=compiledHarness(challengeContracts[challengeKind(id)].fields,language,cases.map(x=>x.input as ExtendedDSAInput))
    return {files:[...files,harness.file],inputs:harness.inputs,language}
  }
  if(language==='Python')files.push({path:'runner.py',content:`import importlib.util,json,os,sys\nspec=importlib.util.spec_from_file_location('solution',os.path.join(os.path.dirname(__file__),'main.py'))\nmodule=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(module)\nprint(json.dumps(module.solve(json.load(sys.stdin)),allow_nan=False))\n`})
  else files.push({path:'runner.mjs',content:`import {readFileSync} from 'node:fs';\nimport {solve} from './${entry}';\nprocess.stdout.write(JSON.stringify(await solve(JSON.parse(readFileSync(0,'utf8')))));\n`})
  return {files,inputs:cases.map(x=>JSON.stringify(x.input)),language}
}
export function scoreChallengeRun(id:TrustedChallengeId,cases:DSACase[],output:unknown) {
  return scoreBehavioralRun(cases,output,(input,actual)=>judgeChallengeResult(id,input,actual),CHALLENGE_CHECK_VERSION)
}
export async function gradeChallengeSubmission(auth:AuthContext,sandboxId:string,submission:ActivitySubmission,signal:AbortSignal) {
  const id=submission.manifest.id
  if(submission.manifest.source!=='curated'||!isTrustedChallengeId(id)||!hasTrustedChallengeGrader(id,submission.language))throw new ApiError(400,'GRADING_UNSUPPORTED','No trusted runner is registered for this activity and language.')
  return gradeBehavioralSubmission(auth,sandboxId,submission,signal,{language:challengeLanguage(id),cases:challengeCases(id),checkVersion:CHALLENGE_CHECK_VERSION,
    payload:(source,cases)=>challengePayload(id,source,cases),judge:(input,actual)=>judgeChallengeResult(id,input,actual)})
}
