import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { PRACTICE_ACTIVITIES } from '@/lib/learning/practice'
import { curatedCompiler } from '@/lib/learning/compiled-activity'
import { activityManifestSchema } from '@/lib/learning/types'
import { practiceSolutions } from './fixtures/practice-solutions'

const folders: string[] = []
afterAll(async () => { await Promise.all(folders.map(path => rm(path, { recursive: true, force: true }))) })
const python = process.env.CODETUTOR_TEST_PYTHON ?? 'python3'
const require = createRequire(import.meta.url)
const vitePath = join(dirname(createRequire(require.resolve('vitest/package.json')).resolve('vite/package.json')), 'bin/vite.js')

describe('substantive practice catalog', () => {
  it('preserves the eighteen route IDs and their original order', () => {
    expect(PRACTICE_ACTIVITIES.map(x => x.id)).toEqual(['javascript','typescript','react','python','java','cpp'].flatMap(track => ['fundamentals','data-flow','composition'].map(stage => `practice-${track}-${stage}`)))
    expect(Object.keys(practiceSolutions).sort()).toEqual(PRACTICE_ACTIVITIES.map(x => x.id).sort())
  })
  it.each(PRACTICE_ACTIVITIES)('$id has bounded teaching material, source, checks and reflection', activity => {
    const parsed = activityManifestSchema.safeParse(activity)
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
    expect(activity.lesson?.hints.length).toBeGreaterThanOrEqual(2)
    expect(activity.lesson?.reflectionQuestions.length).toBeGreaterThanOrEqual(2)
    expect(activity.examples?.length).toBeGreaterThan(0)
    expect(activity.rubric.reduce((sum,x)=>sum+x.weight,0)).toBe(100)
    expect(activity.starterFiles.find(x=>x.path==='LESSON.md')?.content).toContain(activity.instructions[0])
    expect(activity.starterFiles.find(x=>x.path==='REFLECTION.md')?.content).toContain(activity.lesson!.reflectionQuestions[0])
    expect(activity.instructions.join(' ')).toContain('AI rubric')
  })
  it('does not grant a compiler to a generated, mismatched or unknown activity', () => {
    expect(curatedCompiler('practice-java-fundamentals','Java')).toBe('Java')
    expect(curatedCompiler('practice-cpp-data-flow','C++')).toBe('C++')
    for (const [id,language] of [['generated-java-lesson','Java'],['practice-java-fundamentals','C++'],['practice-java-made-up','Java'],['practice-python-fundamentals','Java']]) expect(curatedCompiler(id,language)).toBeUndefined()
  })
  it.each(PRACTICE_ACTIVITIES)('$id: checks fail the starter and pass an independent solution', async activity => {
    const folder=await mkdtemp(join(tmpdir(),'codetutor-practice-check-'))
    folders.push(folder)
    for (const file of activity.starterFiles) {
      await mkdir(dirname(join(folder,file.path)),{recursive:true})
      await writeFile(join(folder,file.path),file.content)
    }
    const isReact=activity.framework==='React'
    if(isReact) await symlink(resolve('node_modules'),join(folder,'node_modules'),'dir')
    if(activity.verify.kind!=='command') throw new Error('Missing visible checks')
    const command=activity.verify.command
    const executable=isReact?process.execPath:command.executable==='node'?process.execPath:command.executable==='python3'?python:command.executable
    const args=isReact?[resolve('node_modules/vitest/vitest.mjs'),'run','--maxWorkers=1']:command.args
    const run=()=>spawnSync(executable,args,{cwd:folder,encoding:'utf8',timeout:45_000,maxBuffer:1_000_000,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}})
    const starter=run()
    expect(starter.error).toBeUndefined()
    expect(starter.status).not.toBe(0)
    expect(starter.stdout+starter.stderr).toContain('Complete the TODO')
    const solution=practiceSolutions[activity.id]
    await writeFile(join(folder,solution.path),solution.content)
    const completed=run()
    expect(completed.error).toBeUndefined()
    expect(completed.status,completed.stdout+completed.stderr).toBe(0)
    if(activity.language==='TypeScript') {
      const typed=spawnSync(process.execPath,[resolve('node_modules/typescript/bin/tsc'),'--project',join(folder,'tsconfig.json')],{encoding:'utf8',timeout:20_000})
      expect(typed.status,typed.stdout+typed.stderr).toBe(0)
    }
    if(isReact) {
      const built=spawnSync(process.execPath,[vitePath,'build'],{cwd:folder,encoding:'utf8',timeout:30_000,maxBuffer:1_000_000})
      expect(built.status,built.stdout+built.stderr).toBe(0)
    }
  },90_000)
})
