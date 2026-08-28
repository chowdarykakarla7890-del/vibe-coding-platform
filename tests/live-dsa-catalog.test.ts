import { expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { Sandbox } from '@vercel/sandbox'
import { getSandboxCredentials } from '@/ai/sandbox'
import { DSA_LANGUAGES } from '@/lib/learning/dsa-foundations'
import { EXTENDED_DSA_IDS, extendedStarter } from '@/lib/learning/dsa-extended'
import { dsaCases } from '@/lib/server/dsa-cases'
import { dsaPayload, scoreDSARun } from '@/lib/server/dsa-grading'
import { captureCommandOutput } from '@/lib/server/command-execution'
import { trustedDSACommand } from '@/lib/sandbox/dsa-invocation'
import { prepareDSARuntime } from '@/lib/sandbox/dsa-runtime'
import { extendedSolution } from './fixtures/dsa-extended-solutions'

vi.mock('server-only',()=>({}))

// Opt-in, one temporary VM and no AI requests or customer data. Exercise real
// compilers, line codecs, process isolation, output limits and host scoring.
it.skipIf(process.env.RUN_LIVE_DSA_CATALOG!=='1')('grades all twelve remaining DSA problems in all five languages',async()=>{
  const name=`codetutor-dsa-catalog-${randomUUID()}`
  let sandbox: Sandbox|undefined
  try {
    sandbox=await Sandbox.create({name,...getSandboxCredentials(),persistent:false,timeout:900_000,signal:AbortSignal.timeout(45_000)})
    const vm=sandbox.currentSession()
    await prepareDSARuntime(vm,'Java')
    const install=await vm.runCommand({cmd:'/usr/bin/apt-get',args:['install','-y','--no-install-recommends','g++'],env:{DEBIAN_FRONTEND:'noninteractive'},sudo:true,timeoutMs:35_000,signal:AbortSignal.timeout(40_000)})
    expect(install.exitCode).toBe(0)
    for(const id of EXTENDED_DSA_IDS)for(const language of DSA_LANGUAGES){
      const cases=dsaCases(id)
      for(const starter of [false,true]){
        // One initial TODO case per variant is enough to prove starters do
        // not earn completion; solutions run the full 24-case contract.
        const selected=starter?cases.slice(0,1):cases
        const payload=JSON.stringify(dsaPayload(id,language,starter?extendedStarter(id,language):extendedSolution(id,language),selected))
        const path=`/tmp/.codetutor-grade-${randomUUID()}.json`
        await vm.writeFiles([{path,content:payload}],{signal:AbortSignal.timeout(10_000)})
        const command=await vm.runCommand({...trustedDSACommand(path,createHash('sha256').update(payload).digest('hex')),detached:true,timeoutMs:60_000,signal:AbortSignal.timeout(10_000)})
        const result=await captureCommandOutput(command,AbortSignal.timeout(65_000),'base64-v1')
        expect(result.exitCode,`${id}/${language}: runner infrastructure`).toBe(0)
        expect(result.outputTruncated).toBe(false)
        const evidence=JSON.parse(result.output)
        expect(evidence.compileFailure,`${id}/${language}: signature compiles`).toBeNull()
        expect(scoreDSARun(id,selected,evidence),`${id}/${language}/${starter?'starter':'solution'}`).toMatchObject(starter?{score:0,passed:false}:{score:100,passed:true})
        expect(await vm.readFileToBuffer({path},{signal:AbortSignal.timeout(5000)})).toBeNull()
      }
      console.log(`PASS: ${id} / ${language} / 24 behavioral cases and failing starter`)
    }
  } finally {
    // Recover a named VM even if the create acknowledgment was lost. Never
    // resume a stopped VM to clean it up; an unconfirmed stop fails the test.
    const cleanup=sandbox??await Sandbox.get({name,resume:false,...getSandboxCredentials(),signal:AbortSignal.timeout(15_000)})
    await cleanup.stop({signal:AbortSignal.timeout(15_000)})
    console.log('Stopped disposable DSA catalog VM.')
  }
},900_000)
