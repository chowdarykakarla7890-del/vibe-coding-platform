import {expect,it,vi} from 'vitest'
import {createHash,randomUUID} from 'node:crypto'
import {Sandbox} from '@vercel/sandbox'
import {getSandboxCredentials} from '@/ai/sandbox'
import {TRUSTED_CHALLENGE_IDS,challengeStarter} from '@/lib/learning/challenges/contracts'
import {reactChallenges} from '@/lib/learning/challenges/react'
import {challengeCases} from '@/lib/server/challenge-cases'
import {challengePayload,scoreChallengeRun} from '@/lib/server/challenge-grading'
import {captureCommandOutput} from '@/lib/server/command-execution'
import {trustedDSACommand} from '@/lib/sandbox/dsa-invocation'
import {prepareDSARuntime} from '@/lib/sandbox/dsa-runtime'
import {challengeSolution,reactChallengeSolutions} from './fixtures/challenge-solutions'
vi.mock('server-only',()=>({}))

it.skipIf(process.env.RUN_LIVE_CHALLENGES!=='1')('verifies all 18 Challenge entries on one disposable Linux VM',async()=>{
  const name=`codetutor-challenges-${randomUUID()}`
  let sandbox:Sandbox|undefined
  try {
    sandbox=await Sandbox.create({name,...getSandboxCredentials(),persistent:false,timeout:900_000,signal:AbortSignal.timeout(45000)})
    const vm=sandbox.currentSession()
    await prepareDSARuntime(vm,'Java')
    const installCompiler=await vm.runCommand({cmd:'/usr/bin/apt-get',args:['install','-y','--no-install-recommends','g++'],env:{DEBIAN_FRONTEND:'noninteractive'},sudo:true,timeoutMs:35000,signal:AbortSignal.timeout(40000)})
    expect(installCompiler.exitCode).toBe(0)
    for(const id of TRUSTED_CHALLENGE_IDS){
      const cases=challengeCases(id)
      for(const starter of [true,false]){
        const selected=starter?cases.slice(0,1):cases
        const payload=JSON.stringify(challengePayload(id,starter?challengeStarter(id):challengeSolution(id),selected)),path=`/tmp/.codetutor-grade-${randomUUID()}.json`
        await vm.writeFiles([{path,content:payload}],{signal:AbortSignal.timeout(10000)})
        const command=await vm.runCommand({...trustedDSACommand(path,createHash('sha256').update(payload).digest('hex')),detached:true,timeoutMs:60000,signal:AbortSignal.timeout(10000)})
        const result=await captureCommandOutput(command,AbortSignal.timeout(65000),'base64-v1')
        expect(result.exitCode,`${id}: infrastructure`).toBe(0)
        expect(result.outputTruncated).toBe(false)
        const evidence=JSON.parse(result.output)
        expect(evidence.compileFailure,`${id}: valid signature`).toBeNull()
        expect(scoreChallengeRun(id,selected,evidence),id).toMatchObject(starter?{score:0,passed:false}:{score:100,passed:true})
        expect(await vm.readFileToBuffer({path},{signal:AbortSignal.timeout(5000)})).toBeNull()
      }
      console.log(`PASS ${id}: 24 trusted cases and failing starter`)
    }
    // Real Linux pipes, root supervisor, nobody payload and kernel cleanup.
    // A valid maximum-sized input must not bypass deadlines/output limits.
    for(const [source,size,failure] of [
      ['while(true){}',65536,'timeout'],
      ["process.stderr.write('x'.repeat(4096));while(true){}",65536,'output-limit'],
      ['export function solve(){return true}',65537,'GRADING_PAYLOAD_INVALID'],
    ] as const){
      const payload=JSON.stringify({language:'JavaScript',files:[{path:'runner.mjs',content:source}],inputs:['x'.repeat(size)]})
      const path=`/tmp/.codetutor-grade-${randomUUID()}.json`
      await vm.writeFiles([{path,content:payload}],{signal:AbortSignal.timeout(10000)})
      const started=Date.now()
      const command=await vm.runCommand({...trustedDSACommand(path,createHash('sha256').update(payload).digest('hex')),detached:true,timeoutMs:60000,signal:AbortSignal.timeout(10000)})
      const result=await captureCommandOutput(command,AbortSignal.timeout(12000),'base64-v1')
      expect(Date.now()-started).toBeLessThan(12000)
      expect(JSON.parse(result.output)).toMatchObject(size>65536?{error:failure}:{compileFailure:null,cases:[{output:'',failure}]})
      expect(result.exitCode).toBe(size>65536?1:0)
      expect(await vm.readFileToBuffer({path},{signal:AbortSignal.timeout(5000)})).toBeNull()
    }
    const guests=await vm.runCommand({cmd:'/usr/bin/pgrep',args:['-u','65534'],sudo:true,timeoutMs:2000,signal:AbortSignal.timeout(5000)})
    expect(guests.exitCode,'I/O deadline and output-limit leave no grading subprocesses').toBe(1)
    console.log('PASS input admission, blocked stdin deadline, output limit and process cleanup')
    const root='/tmp/codetutor-react-challenges'
    const pkg=reactChallenges[0].starterFiles.find(x=>x.path==='package.json')!
    await vm.writeFiles([{path:`${root}/package.json`,content:pkg.content}],{signal:AbortSignal.timeout(10000)})
    const install=await vm.runCommand({cmd:'npm',args:['install','--ignore-scripts','--no-audit','--no-fund'],cwd:root,timeoutMs:120000,signal:AbortSignal.timeout(125000)})
    expect(install.exitCode).toBe(0)
    for(const activity of reactChallenges){
      const cwd=`${root}/${activity.id}`
      await vm.writeFiles(activity.starterFiles.map(f=>({path:`${cwd}/${f.path}`,content:f.content})),{signal:AbortSignal.timeout(10000)})
      const run=()=>vm.runCommand({cmd:'npm',args:['test','--','--run'],cwd,timeoutMs:45000,signal:AbortSignal.timeout(50000)})
      const starter=await run()
      expect(starter.exitCode).not.toBe(0)
      expect((await starter.stdout())+(await starter.stderr())).toContain('Complete the TODO')
      await vm.writeFiles([{path:`${cwd}/src/App.jsx`,content:reactChallengeSolutions[activity.id]}],{signal:AbortSignal.timeout(10000)})
      expect((await run()).exitCode,activity.id).toBe(0)
      expect((await vm.runCommand({cmd:'npm',args:['run','build'],cwd,timeoutMs:30000,signal:AbortSignal.timeout(35000)})).exitCode).toBe(0)
      console.log(`PASS ${activity.id}: interaction checks and production build`)
    }
  } finally {
    const cleanup=sandbox??await Sandbox.get({name,resume:false,...getSandboxCredentials(),signal:AbortSignal.timeout(15000)})
    await cleanup.stop({signal:AbortSignal.timeout(15000)})
    console.log('Stopped disposable Challenge matrix VM.')
  }
},900000)
