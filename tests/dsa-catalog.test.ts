import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { DSA_ACTIVITIES } from '@/lib/learning/catalog'
import { TRUSTED_DSA_IDS, isTrustedDSAId } from '@/lib/learning/dsa'
import { DSA_LANGUAGES } from '@/lib/learning/dsa-foundations'
import { EXTENDED_DSA_IDS, extendedSpecification, extendedDSAActivity, type ExtendedDSAId } from '@/lib/learning/dsa-extended'
import { activityManifestSchema } from '@/lib/learning/types'
import { dsaCases, judgeDSAResult } from '@/lib/server/dsa-cases'
import { dsaPayload, hasTrustedDSAGrader, scoreDSARun } from '@/lib/server/dsa-grading'
import { extendedSolution } from './fixtures/dsa-extended-solutions'

vi.mock('server-only', () => ({}))

const int=z.number().int(), text=z.string().regex(/^[a-z]*$/).max(40)
const inputSchemas: Record<ExtendedDSAId,z.ZodType> = {
  'dsa-python-merge-intervals':z.object({ intervals:z.array(z.tuple([int.min(-1000).max(1000),int.min(-1000).max(1000)]).refine(([a,b])=>a<=b)).max(20) }).strict(),
  'dsa-python-longest-substring':z.object({ text:z.string().regex(/^[a-z]*$/).max(200) }).strict(),
  'dsa-python-tree-level-order':z.object({ tree:z.array(int.min(-50).max(50).nullable()).max(63) }).strict(),
  'dsa-python-number-islands':z.object({ grid:z.array(z.string().regex(/^[01]*$/).max(12)).max(12).refine(rows=>rows.every(row=>row.length===rows[0].length)) }).strict(),
  'dsa-python-coin-change':z.object({ coins:z.array(int.min(1).max(50)).max(12), amount:int.min(0).max(200) }).strict(),
  'dsa-python-top-k':z.object({ nums:z.array(int.min(-20).max(20)).max(80), k:int.min(0).max(50) }).strict(),
  'dsa-python-linked-cycle':z.object({ next:z.array(int).max(80),head:int }).strict().refine(v=>[v.head,...v.next].every(n=>n===-1||(n>=0&&n<v.next.length))),
  'dsa-python-word-break':z.object({ text,words:z.array(z.string().regex(/^[a-z]+$/).max(8)).max(20) }).strict(),
  'dsa-python-course-schedule':z.object({ numCourses:int.min(0).max(12), prerequisites:z.array(z.tuple([int,int])).max(40) }).strict().refine(v=>v.prerequisites.flat().every(n=>n>=0&&n<v.numCourses)),
  'dsa-python-lru-cache':z.object({ capacity:int.min(0).max(8),operations:z.array(z.union([z.tuple([z.literal(0),int.min(-9).max(9)]),z.tuple([z.literal(1),int.min(-9).max(9),int.min(-100).max(100)])])).max(40) }).strict(),
  'dsa-python-median-stream':z.object({ nums:z.array(int.min(-1000).max(1000)).max(32) }).strict(),
  'dsa-python-edit-distance':z.object({ source:text,target:text }).strict(),
}

it('registers exactly the existing fifteen DSA routes, with no generic activity fallback', () => {
  const slugs=['two-sum','valid-parentheses','binary-search','merge-intervals','longest-substring','tree-level-order','number-islands','coin-change','top-k','linked-cycle','word-break','course-schedule','lru-cache','median-stream','edit-distance']
  expect(DSA_ACTIVITIES.map(activity=>activity.id)).toEqual(slugs.map(slug=>`dsa-python-${slug}`))
  expect(TRUSTED_DSA_IDS).toHaveLength(15)
  for(const id of TRUSTED_DSA_IDS)for(const language of DSA_LANGUAGES)expect(hasTrustedDSAGrader(id,language)).toBe(true)
  for(const id of ['dsa-python-custom','__proto__','constructor','dsa-python-top-k-suffix'])expect(isTrustedDSAId(id)).toBe(false)
  expect(hasTrustedDSAGrader('dsa-python-top-k','Ruby')).toBe(false)
})

describe.each(EXTENDED_DSA_IDS)('%s', id => {
  it('ships concrete contracts, correct examples, and typed failing starters in all languages', () => {
    const activity=extendedDSAActivity(id)
    expect(activityManifestSchema.safeParse(activity).success).toBe(true)
    expect(activity.examples).toHaveLength(3)
    for(const example of extendedSpecification(id).examples){expect(inputSchemas[id].safeParse(example.input).success).toBe(true);expect(judgeDSAResult(id,example.input,example.output)).toBe(true)}
    for(const language of DSA_LANGUAGES){const variant=activity.variants![language];expect(variant.starterFiles).toHaveLength(1);expect(variant.starterFiles[0].content).toContain('Complete the TODO');expect(variant.verify).toEqual({kind:'rubric'})}
  })

  it('agrees with an independent implementation across boundary and generated inputs without mutating them', () => {
    // Only our checked-in reference fixture is evaluated; no learner source.
    const solve=new Function(extendedSolution(id,'JavaScript').replace('export function','function')+';return solve;')()
    for(let seed=1;seed<=20;seed++){
      let state=seed
      const integer=(min:number,max:number)=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return min+state%(max-min)}
      const cases=dsaCases(id,integer), before=structuredClone(cases)
      expect(cases).toHaveLength(24)
      const results=cases.map(test=>{
        expect(inputSchemas[id].safeParse(test.input).success).toBe(true)
        const value=solve(structuredClone(test.input))
        expect(judgeDSAResult(id,test.input,value),JSON.stringify(test.input)).toBe(true)
        expect(judgeDSAResult(id,test.input,{score:100,passed:true})).toBe(false)
        const output=JSON.stringify(value)
        expect(Buffer.byteLength(output)).toBeLessThan(2048)
        return {output,failure:null}
      })
      expect(scoreDSARun(id,cases,{compileFailure:null,cases:results})).toMatchObject({score:100,passed:true})
      expect(cases).toEqual(before)
    }
  })

  it.each(DSA_LANGUAGES)('stages only solution and fixed harness for %s', language => {
    const cases=dsaCases(id), payload=dsaPayload(id,language,'submitted solution',cases)
    expect(Object.keys(payload)).toEqual(['files','inputs','language'])
    expect(payload.files).toHaveLength(2)
    expect(payload.files[0].content).toBe('submitted solution')
    expect(payload.inputs).toHaveLength(24)
    expect(payload.inputs.every(input=>Buffer.byteLength(input)<=8192)).toBe(true)
  })
})

it('uses exact structured outputs and rejects common plausible wrong answers', () => {
  expect(judgeDSAResult('dsa-python-top-k',{nums:[2,1,2,1],k:2},[2,1])).toBe(false)
  expect(judgeDSAResult('dsa-python-merge-intervals',{intervals:[[1,1],[2,2]]},[[1,2]])).toBe(false)
  expect(judgeDSAResult('dsa-python-tree-level-order',{tree:[1,null,2,3]},[[1],[2]])).toBe(false)
  expect(judgeDSAResult('dsa-python-linked-cycle',{next:[-1,1],head:0},true)).toBe(false)
  expect(judgeDSAResult('dsa-python-number-islands',{grid:['10','01']},1)).toBe(false)
  expect(judgeDSAResult('dsa-python-coin-change',{coins:[1,3,4],amount:6},3)).toBe(false)
  expect(judgeDSAResult('dsa-python-longest-substring',{text:'abba'},3)).toBe(false)
  expect(judgeDSAResult('dsa-python-word-break',{text:'cars',words:['car','ca','rs']},false)).toBe(false)
  expect(judgeDSAResult('dsa-python-course-schedule',{numCourses:3,prerequisites:[[1,2],[2,1]]},true)).toBe(false)
  expect(judgeDSAResult('dsa-python-lru-cache',{capacity:2,operations:[[1,1,1],[1,2,2],[0,1],[1,3,3],[0,2]]},[1,2])).toBe(false)
  expect(judgeDSAResult('dsa-python-median-stream',{nums:[-2,-1]},[-2,-1])).toBe(false)
  expect(judgeDSAResult('dsa-python-edit-distance',{source:'ab',target:'ba'},1)).toBe(false)
})
