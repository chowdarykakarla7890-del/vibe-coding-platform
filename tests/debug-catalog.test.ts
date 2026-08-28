import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { DEBUG_ACTIVITIES } from '@/lib/learning/debug'
import { curatedCompiler } from '@/lib/learning/compiled-activity'
import { activityManifestSchema } from '@/lib/learning/types'
import { debugRepairs, repairDebugSource } from './fixtures/debug-repairs'

const folders: string[] = []
afterAll(async () => { await Promise.all(folders.map(path => rm(path, { recursive: true, force: true }))) })
const python = process.env.CODETUTOR_TEST_PYTHON ?? 'python3'
const require = createRequire(import.meta.url)
const vitePath = join(dirname(createRequire(require.resolve('vitest/package.json')).resolve('vite/package.json')), 'bin/vite.js')

describe('reproducible debugging catalog', () => {
  it('preserves all twelve original route IDs and order', () => {
    expect(DEBUG_ACTIVITIES.map(x=>x.id)).toEqual(['javascript','typescript','react','python','java','cpp'].flatMap(track=>['state-bug','edge-cases'].map(stage=>`debug-${track}-${stage}`)))
    expect(Object.keys(debugRepairs).sort()).toEqual(DEBUG_ACTIVITIES.map(x=>x.id).sort())
  })
  it.each(DEBUG_ACTIVITIES)('$id contains real code and bounded diagnostic teaching material', activity => {
    const parsed=activityManifestSchema.safeParse(activity)
    expect(parsed.success,JSON.stringify(parsed.error?.issues)).toBe(true)
    expect(activity.mode).toBe('debug')
    expect(activity.rubric.reduce((sum,item)=>sum+item.weight,0)).toBe(100)
    expect(activity.instructions.join(' ')).toContain('Reproduce the failing check before changing code')
    expect(activity.instructions.join(' ')).toContain('AI rubric')
    expect(activity.starterFiles.find(x=>x.path==='DIAGNOSIS.md')?.content).toContain('Root cause')
    expect(activity.lesson?.hints).toHaveLength(3)
    expect(activity.lesson?.reflectionQuestions).toHaveLength(2)
    const source=activity.starterFiles.find(x=>x.path===debugRepairs[activity.id].path)!.content
    expect(source).not.toContain('Complete the TODO')
    expect(repairDebugSource(activity.id,source)).not.toBe(source)
  })
  it('prepares compilers only for exact curated ID and language matches', () => {
    for(const activity of DEBUG_ACTIVITIES){
      expect(curatedCompiler(activity.id,activity.language)).toBe(['Java','C++'].includes(activity.language)?activity.language:undefined)
      expect(curatedCompiler(activity.id,activity.language==='Java'?'C++':'Java')).toBeUndefined()
    }
    expect(curatedCompiler('debug-java-untrusted','Java')).toBeUndefined()
    expect(curatedCompiler('generated-debug-java-state-bug','Java')).toBeUndefined()
  })
  it.each(DEBUG_ACTIVITIES)('$id fails behavioral assertions and passes the same checks after a focused repair', async activity => {
    const folder=await mkdtemp(join(tmpdir(),'codetutor-debug-check-'))
    folders.push(folder)
    for(const file of activity.starterFiles){await mkdir(dirname(join(folder,file.path)),{recursive:true});await writeFile(join(folder,file.path),file.content)}
    const isReact=activity.framework==='React'
    if(isReact)await symlink(resolve('node_modules'),join(folder,'node_modules'),'dir')
    if(activity.verify.kind!=='command')throw new Error('Missing debugging checks')
    const command=activity.verify.command
    const executable=isReact?process.execPath:command.executable==='node'?process.execPath:command.executable==='python3'?python:command.executable
    const args=isReact?[resolve('node_modules/vitest/vitest.mjs'),'run','--maxWorkers=1']:command.args
    const run=()=>spawnSync(executable,args,{cwd:folder,encoding:'utf8',timeout:45_000,maxBuffer:1_000_000,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}})
    // A missing tool, syntax error or unimplemented TODO is not a debug exercise.
    const starter=run()
    expect(starter.error).toBeUndefined()
    expect(starter.status).not.toBeNull()
    expect(starter.status).not.toBe(0)
    expect(starter.stdout+starter.stderr).toMatch(/assert/i)
    if(activity.language==='TypeScript'){
      const typed=spawnSync(process.execPath,[resolve('node_modules/typescript/bin/tsc'),'--project',join(folder,'tsconfig.json')],{encoding:'utf8',timeout:20_000})
      expect(typed.status,typed.stdout+typed.stderr).toBe(0)
    }
    const repair=debugRepairs[activity.id]
    const source=activity.starterFiles.find(x=>x.path===repair.path)!.content
    await writeFile(join(folder,repair.path),repairDebugSource(activity.id,source))
    const fixed=run()
    expect(fixed.error).toBeUndefined()
    expect(fixed.status,fixed.stdout+fixed.stderr).toBe(0)
    if(isReact){
      const build=spawnSync(process.execPath,[vitePath,'build'],{cwd:folder,encoding:'utf8',timeout:30_000,maxBuffer:1_000_000})
      expect(build.status,build.stdout+build.stderr).toBe(0)
    }
  },90_000)
})
