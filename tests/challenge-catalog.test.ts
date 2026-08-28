import { afterAll, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { CHALLENGE_ACTIVITIES } from '@/lib/learning/challenges'
import { CHALLENGE_KINDS, TRUSTED_CHALLENGE_IDS, challengeLanguage, challengeStarter, hasTrustedChallengeGrader } from '@/lib/learning/challenges/contracts'
import { challengeCases, expectedChallengeResult, judgeChallengeResult } from '@/lib/server/challenge-cases'
import { challengePayload, scoreChallengeRun } from '@/lib/server/challenge-grading'
import { activityManifestSchema } from '@/lib/learning/types'
import { challengeSolution, reactChallengeSolutions } from './fixtures/challenge-solutions'

vi.mock('server-only',()=>({}))
const folders:string[]=[]
afterAll(async()=>{await Promise.all(folders.map(path=>rm(path,{recursive:true,force:true})))})
const python=process.env.CODETUTOR_TEST_PYTHON??'python3'
const require=createRequire(import.meta.url)
const vitePath=join(dirname(createRequire(require.resolve('vitest/package.json')).resolve('vite/package.json')),'bin/vite.js')
const command=(cwd:string,cmd:string,args:string[],input?:string)=>spawnSync(cmd,args,{cwd,input,encoding:'utf8',timeout:30_000,maxBuffer:1_000_000,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}})

it('preserves 18 original Challenge IDs and validates complete contracts',()=>{
  expect(CHALLENGE_ACTIVITIES.map(x=>x.id)).toEqual(['javascript','typescript','react','python','java','cpp'].flatMap(track=>CHALLENGE_KINDS.map(kind=>`challenge-${track}-${kind}`)))
  for(const activity of CHALLENGE_ACTIVITIES){
    const parsed=activityManifestSchema.safeParse(activity)
    expect(parsed.success,JSON.stringify(parsed.error?.issues)).toBe(true)
    expect(activity.lesson?.hints).toHaveLength(3)
    expect(activity.starterFiles.some(f=>f.path==='REFLECTION.md')).toBe(true)
    expect(activity.rubric.reduce((sum,x)=>sum+x.weight,0)).toBe(100)
    expect(hasTrustedChallengeGrader(activity.id,activity.language)).toBe(activity.framework!=='React')
  }
  expect(hasTrustedChallengeGrader('generated-challenge-java-transform','Java')).toBe(false)
  expect(hasTrustedChallengeGrader('challenge-java-transform','C++')).toBe(false)
})

it.each(CHALLENGE_KINDS)('checks %s oracles independently across generated cases and adversarial answers',async kind=>{
  const id=`challenge-javascript-${kind}` as const
  const {solve}=await import(`data:text/javascript;base64,${Buffer.from(challengeSolution(id)).toString('base64')}`)
  for(let trial=0;trial<20;trial++){
    const cases=challengeCases(id), before=structuredClone(cases)
    expect(cases).toHaveLength(24)
    // Leave space for JSONB formatting and fingerprints in the 128 KiB plan.
    expect(Buffer.byteLength(JSON.stringify(cases).replaceAll(',',', ').replaceAll(':',': '))).toBeLessThan(120_000)
    for(const test of cases){
      const input=test.input as Record<string,number[]|number|string>
      const result=solve(structuredClone(input))
      expect(judgeChallengeResult(id,test.input,result)).toBe(true)
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(2048)
      expect(judgeChallengeResult(id,test.input,{score:100,passed:true})).toBe(false)
      if(kind==='performance'){
        const nums=input.nums as number[]
        if(nums.length<=100){let brute=0;for(let a=0;a<nums.length;a++){let sum=0;for(let b=a;b<nums.length;b++){sum+=nums[b];if(sum===input.target)brute++}}expect(result).toBe(brute)}
        else expect(result).toBe((input.target===5000)?5001:nums.every(n=>n===0)?50_005_000:25_000_000)
      }
    }
    expect(cases).toEqual(before)
  }
  const cases=challengeCases(id), outputs=cases.map(test=>({output:JSON.stringify(expectedChallengeResult(id,test.input as never)),failure:null as string|null}))
  outputs[0]={output:'{"score":100}',failure:null}
  expect(scoreChallengeRun(id,cases,{compileFailure:null,cases:outputs})).toMatchObject({score:95,passed:false})
  expect(()=>scoreChallengeRun(id,cases,{compileFailure:null,cases:[]})).toThrow('complete evidence')
})

it('rejects plausible shortcuts and wrong result types',()=>{
  const transform='challenge-javascript-transform',validator='challenge-javascript-validator',performance='challenge-javascript-performance'
  expect(judgeChallengeResult(transform,{nums:[2,0,1,2]},[1,2,2,0])).toBe(false)
  expect(judgeChallengeResult(transform,{nums:[2,0,1,2]},[2,1,2])).toBe(false)
  for(const text of ['1.2.3.4 ','1.2.3.04','1e2.2.3.4','-0.2.3.4','1.2.3.4.5'])expect(judgeChallengeResult(validator,{text},true)).toBe(false)
  expect(judgeChallengeResult(validator,{text:'1.2.3.4'},'true')).toBe(false)
  expect(judgeChallengeResult(performance,{nums:[0,0,0],target:0},3)).toBe(false)
  expect(judgeChallengeResult(performance,{nums:[],target:0},1)).toBe(false)
})

it.each(TRUSTED_CHALLENGE_IDS)('%s executes its exact language signature and rejects an untouched starter',async id=>{
  const language=challengeLanguage(id), cases=challengeCases(id), folder=await mkdtemp(join(tmpdir(),'codetutor-challenge-'))
  folders.push(folder)
  for(const starter of [true,false]){
    const payload=challengePayload(id,starter?challengeStarter(id):challengeSolution(id),cases)
    expect(payload.inputs.every(input=>Buffer.byteLength(input)<=65536)).toBe(true)
    expect(payload.files).toHaveLength(2)
    expect(Object.keys(payload)).toEqual(['files','inputs','language'])
    for(const file of payload.files)await writeFile(join(folder,file.path),file.content)
    if(language==='Java'||language==='C++'){
      const compile=language==='Java'?command(folder,'javac',['Main.java','Runner.java']):command(folder,'g++',['-std=c++17','runner.cpp','-o','runner'])
      expect(compile.status,compile.stdout+compile.stderr).toBe(0)
    }
    if(language==='TypeScript'){
      const typed=command(folder,process.execPath,[resolve('node_modules/typescript/bin/tsc'),'--noEmit','--strict','--target','ES2022','--skipLibCheck','main.ts'])
      expect(typed.status,typed.stdout+typed.stderr).toBe(0)
    }
    const cmd=language==='Java'?'java':language==='C++'?join(folder,'runner'):language==='Python'?python:process.execPath
    const args=language==='Java'?['-cp',folder,'Runner']:language==='C++'?[]:language==='Python'?['runner.py']:['runner.mjs']
    for(const [index,input]of (starter?payload.inputs.slice(0,1):payload.inputs).entries()){
      const result=command(folder,cmd,args,input)
      expect(result.error).toBeUndefined()
      if(starter){expect(result.status).not.toBe(0);expect(result.stderr).toContain('Complete the TODO')}
      else {expect(result.status,result.stdout+result.stderr).toBe(0);expect(judgeChallengeResult(id,cases[index].input,JSON.parse(result.stdout))).toBe(true)}
    }
  }
},90_000)

it.each(CHALLENGE_ACTIVITIES.filter(x=>x.framework==='React'))('$id has failing interaction checks, a passing solution and a buildable preview',async activity=>{
  const folder=await mkdtemp(join(tmpdir(),'codetutor-react-challenge-'));folders.push(folder)
  for(const file of activity.starterFiles){await mkdir(dirname(join(folder,file.path)),{recursive:true});await writeFile(join(folder,file.path),file.content)}
  await symlink(resolve('node_modules'),join(folder,'node_modules'),'dir')
  const args=[resolve('node_modules/vitest/vitest.mjs'),'run','--maxWorkers=1']
  const starter=command(folder,process.execPath,args)
  expect(starter.status).not.toBe(0);expect(starter.stdout+starter.stderr).toContain('Complete the TODO')
  await writeFile(join(folder,'src/App.jsx'),reactChallengeSolutions[activity.id])
  const fixed=command(folder,process.execPath,args)
  expect(fixed.status,fixed.stdout+fixed.stderr).toBe(0)
  const build=command(folder,process.execPath,[vitePath,'build'])
  expect(build.status,build.stdout+build.stderr).toBe(0)
},90_000)
