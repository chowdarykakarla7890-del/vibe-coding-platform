import {afterAll,describe,expect,it} from 'vitest'
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,dirname,resolve} from 'node:path'
import {spawnSync} from 'node:child_process'
import {createRequire} from 'node:module'
import {PROJECT_ACTIVITIES,getActivity} from '@/lib/learning/catalog'
import {activityManifestSchema} from '@/lib/learning/types'
import {curatedCompiler} from '@/lib/learning/compiled-activity'
import {projectSolutions} from './fixtures/project-solutions'

const folders:string[]=[]
afterAll(async()=>{await Promise.all(folders.map(path=>rm(path,{recursive:true,force:true})))})
const python=process.env.CODETUTOR_TEST_PYTHON??'python3'
const require=createRequire(import.meta.url)
const vitePath=join(dirname(createRequire(require.resolve('vitest/package.json')).resolve('vite/package.json')),'bin/vite.js')

describe('substantive project blueprints',()=>{
 it('preserves original IDs, titles and order, with a reference for every project',()=>{
  expect(PROJECT_ACTIVITIES.map(x=>x.id)).toEqual(['javascript','typescript','react','python','java','cpp'].map(track=>`project-${track}-blueprint`))
  expect(PROJECT_ACTIVITIES.map(x=>x.title)).toEqual(['Personal finance tracker','Typed issue board','Accessible habit coach','Study planner CLI','Library lending service','Terminal task engine'])
  expect(Object.keys(projectSolutions).sort()).toEqual(PROJECT_ACTIVITIES.map(x=>x.id).sort())
 })
 it.each(PROJECT_ACTIVITIES)('$id is valid, staged and honest about assessment',activity=>{
  const parsed=activityManifestSchema.safeParse(activity);expect(parsed.success,JSON.stringify(parsed.error?.issues)).toBe(true)
  expect(getActivity(activity.id)).toBe(activity);expect(activity.mode).toBe('project');expect(activity.milestones).toHaveLength(4)
  expect(activity.milestones!.map(x=>x.id)).toEqual(['m1','m2','m3','m4'])
  expect(activity.rubric.reduce((n,x)=>n+x.weight,0)).toBe(100)
  expect(activity.instructions.join(' ')).toContain('AI-assessed');expect(activity.instructions.join(' ')).toContain('not server-trusted grading')
  expect(activity.starterFiles.find(x=>x.path==='MILESTONES.md')?.content).toContain('Evidence and decisions: TODO')
  expect(activity.starterFiles.find(x=>x.path==='REFLECTION.md')?.content).toContain(activity.lesson!.reflectionQuestions[0])
  // The full starter and reference must fit the existing all-or-nothing AI
  // evidence budget; this does not guarantee arbitrary learner additions fit.
  const replacements=projectSolutions[activity.id]
  const complete=activity.starterFiles.map(file=>replacements.find(x=>x.path===file.path)??file)
  expect(Buffer.byteLength(JSON.stringify(activity.starterFiles),'utf8')).toBeLessThanOrEqual(64_000)
  expect(Buffer.byteLength(JSON.stringify(complete),'utf8')).toBeLessThanOrEqual(64_000)
  expect(curatedCompiler(activity.id,activity.language)).toBe(['Java','C++'].includes(activity.language)?activity.language:undefined)
  expect(curatedCompiler(activity.id,activity.language==='Java'?'C++':'Java')).toBeUndefined()
 })
 it('validates milestone limits without requiring them on older manifests',()=>{
  const base=PROJECT_ACTIVITIES[0],milestone=base.milestones![0]
  expect(activityManifestSchema.safeParse({...base,milestones:undefined}).success).toBe(true)
  for(const milestones of [[],[milestone,milestone],Array.from({length:9},(_,i)=>({...milestone,id:`m${i}`})),[{...milestone,id:'../bad'}],[{...milestone,acceptance:[]}],[{...milestone,check:{executable:'node',args:Array(25).fill('x')}}]]){
   expect(activityManifestSchema.safeParse({...base,milestones}).success).toBe(false)
  }
  expect(curatedCompiler('generated-project-java-blueprint','Java')).toBeUndefined()
  expect(curatedCompiler('project-java-unknown','Java')).toBeUndefined()
 })
 it.each(PROJECT_ACTIVITIES)('$id fails unfinished, passes all four milestones and the complete workflow, and builds where applicable',async activity=>{
  const folder=await mkdtemp(join(tmpdir(),'codetutor-project-check-'));folders.push(folder)
  for(const file of activity.starterFiles){await mkdir(dirname(join(folder,file.path)),{recursive:true});await writeFile(join(folder,file.path),file.content)}
  const web=['JavaScript','TypeScript'].includes(activity.language),react=activity.framework==='React'
  if(web)await symlink(resolve('node_modules'),join(folder,'node_modules'),'dir')
  if(activity.verify.kind!=='command')throw Error('Missing project checks')
  const run=(command:{executable:string;args:string[]})=>{
   const executable=command.executable==='npm'?process.execPath:command.executable==='node'?process.execPath:command.executable==='python3'?python:command.executable
   const args=command.executable==='npm'?(react?[resolve('node_modules/vitest/vitest.mjs'),'run','--maxWorkers=1',...command.args.slice(3)]:['--test','checks.test.mjs']):command.args
   return spawnSync(executable,args,{cwd:folder,encoding:'utf8',timeout:45_000,maxBuffer:1_000_000,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}})
  }
  const starter=run(activity.verify.command);expect(starter.error).toBeUndefined();expect(starter.status).not.toBeNull();expect(starter.status).not.toBe(0);expect(starter.stdout+starter.stderr).toMatch(/TODO/)
  if(activity.language==='TypeScript'){
   const typed=spawnSync(process.execPath,[resolve('node_modules/typescript/bin/tsc'),'--project',join(folder,'tsconfig.json')],{encoding:'utf8',timeout:20_000});expect(typed.status,typed.stdout+typed.stderr).toBe(0)
  }
  for(const file of projectSolutions[activity.id])await writeFile(join(folder,file.path),file.content)
  for(const command of [...activity.milestones!.map(x=>x.check),activity.verify.command]){
   const result=run(command);expect(result.error).toBeUndefined();expect(result.status,JSON.stringify(command)+'\n'+result.stdout+result.stderr).toBe(0)
   expect(result.stdout+result.stderr).not.toMatch(/No test files found/)
   if(react)expect(result.stdout+result.stderr).toMatch(/[1-9][0-9]* passed/)
  }
  if(['Java','C++'].includes(activity.language))expect(run({executable:'python3',args:['check.py','M9']}).status).not.toBe(0)
  if(activity.language==='TypeScript'){
   const typed=spawnSync(process.execPath,[resolve('node_modules/typescript/bin/tsc'),'--project',join(folder,'tsconfig.json')],{encoding:'utf8',timeout:20_000});expect(typed.status,typed.stdout+typed.stderr).toBe(0)
  }
  if(web){const build=spawnSync(process.execPath,[vitePath,'build'],{cwd:folder,encoding:'utf8',timeout:30_000,maxBuffer:1_000_000});expect(build.status,build.stdout+build.stderr).toBe(0)}
 },180_000)
})
