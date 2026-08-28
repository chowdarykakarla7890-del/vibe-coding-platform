import {expect,it} from 'vitest'
import {randomUUID} from 'node:crypto'
import {Sandbox} from '@vercel/sandbox'
import {getSandboxCredentials} from '@/ai/sandbox'
import {prepareLearningCompiler} from '@/lib/sandbox/learning-compiler'
import {PROJECT_ACTIVITIES} from '@/lib/learning/blueprints'
import {projectSolutions} from './fixtures/project-solutions'

// Explicit opt-in: one disposable VM, no AI, customer source or test accounts.
it.skipIf(process.env.RUN_LIVE_PROJECTS!=='1')('verifies six project workflows, staged checks and web builds on Linux',async()=>{
 const name=`codetutor-projects-${randomUUID()}`
 let sandbox:Sandbox|undefined
 try{
  sandbox=await Sandbox.create({name,...getSandboxCredentials(),persistent:false,timeout:900_000,signal:AbortSignal.timeout(45_000)})
  const vm=sandbox.currentSession()
  await prepareLearningCompiler(vm,'Java');await prepareLearningCompiler(vm,'C++')
  const root='/tmp/codetutor-project-matrix'
  const reactPackage=JSON.parse(PROJECT_ACTIVITIES.find(x=>x.framework==='React')!.starterFiles.find(x=>x.path==='package.json')!.content)
  reactPackage.devDependencies.typescript='5.9.3'
  await vm.writeFiles([{path:`${root}/package.json`,content:JSON.stringify(reactPackage)}],{signal:AbortSignal.timeout(10_000)})
  const install=await vm.runCommand({cmd:'npm',args:['install','--ignore-scripts','--no-audit','--no-fund'],cwd:root,timeoutMs:120_000,signal:AbortSignal.timeout(125_000)})
  expect(install.exitCode,'Pinned browser dependencies install').toBe(0)
  for(const activity of PROJECT_ACTIVITIES){
   const cwd=`${root}/${activity.id}`
   await vm.writeFiles(activity.starterFiles.map(file=>({path:`${cwd}/${file.path}`,content:file.content})),{signal:AbortSignal.timeout(10_000)})
   if(activity.verify.kind!=='command')throw Error('Missing project checks')
   const run=(spec:{executable:string;args:string[]})=>vm.runCommand({cmd:spec.executable,args:spec.args,cwd,timeoutMs:45_000,signal:AbortSignal.timeout(50_000)})
   const starter=await run(activity.verify.command)
   expect(starter.exitCode,`${activity.id}: unfinished starter`).not.toBe(0)
   expect((await starter.stdout())+(await starter.stderr())).toMatch(/TODO/)
   await vm.writeFiles(projectSolutions[activity.id].map(file=>({path:`${cwd}/${file.path}`,content:file.content})),{signal:AbortSignal.timeout(10_000)})
   for(const command of [...activity.milestones!.map(x=>x.check),activity.verify.command]){
    const checked=await run(command)
    expect(checked.exitCode,`${activity.id}: ${[command.executable,...command.args].join(' ')}`).toBe(0)
    if(activity.framework==='React')expect((await checked.stdout())+(await checked.stderr())).toMatch(/[1-9][0-9]* passed/)
   }
   if(activity.language==='TypeScript')expect((await run({executable:'npm',args:['run','typecheck']})).exitCode,'Strict TypeScript checks').toBe(0)
   if(['JavaScript','TypeScript'].includes(activity.language)){
    expect((await run({executable:'npm',args:['run','build']})).exitCode,`${activity.id}: production build`).toBe(0)
   }
   if(['Java','C++'].includes(activity.language))expect((await run({executable:'python3',args:['check.py','M9']})).exitCode,'Unknown milestone rejected').not.toBe(0)
   console.log(`PASS ${activity.id}: unfinished starter, four stages, full workflow${['JavaScript','TypeScript'].includes(activity.language)?', browser build':''}`)
  }
 }finally{
  const cleanup=sandbox??await Sandbox.get({name,resume:false,...getSandboxCredentials(),signal:AbortSignal.timeout(15_000)})
  await cleanup.stop({signal:AbortSignal.timeout(15_000)})
  console.log('Stopped disposable Project matrix VM.')
 }
},900_000)
