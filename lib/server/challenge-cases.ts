import 'server-only'
import { randomInt } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { challengeKind, type TrustedChallengeId } from '@/lib/learning/challenges/contracts'
import type { DSACase } from './dsa-cases'
import type { ExtendedDSAInput } from '@/lib/learning/dsa-extended'

export const CHALLENGE_CHECK_VERSION='challenges-v1'
export function challengeCases(id: TrustedChallengeId, integer: (min:number,max:number)=>number=randomInt): DSACase[] {
  const kind=challengeKind(id)
  let inputs: ExtendedDSAInput[]
  if(kind==='transform') {
    inputs=[[],[0],[1],[0,0],[0,3,0,-1,3],[3,-1,3],[1,0,2,0],[-1,-1,0],[0,-1000,1000,0],Array(200).fill(0),Array(200).fill(7),Array.from({length:200},(_,i)=>i%3===0?0:i-100)].map(nums=>({nums}))
    for(let i=0;i<12;i++)inputs.push({nums:Array.from({length:integer(0,201)},()=>integer(0,3)===0?0:integer(-1000,1001))})
  } else if(kind==='validator') {
    inputs=['','0.0.0.0','255.255.255.255','1.2.3.4','256.0.0.1','01.2.3.4','1.2.3','1.2.3.4.','1..3.4','+1.2.3.4','1.2.3.4x',' 1.2.3.4'].map(text=>({text}))
    for(let i=0;i<6;i++) {
      const octets=Array.from({length:4},()=>integer(0,256).toString())
      inputs.push({text:octets.join('.')})
      const bad=[...octets]
      bad[integer(0,4)]=[String(integer(256,1000)),`0${octets[0]}`,'-1','1e2','1 ',''][i]
      inputs.push({text:bad.join('.')})
    }
  } else {
    inputs=[{nums:[],target:0},{nums:[0],target:0},{nums:[1],target:0},{nums:[1,1,1],target:2},{nums:[1,-1,1],target:1},{nums:[0,0,0],target:0},{nums:[-1,-1,1],target:-1},{nums:[2,-2,2,-2],target:0},{nums:[10,-10],target:100000},
      {nums:Array(10000).fill(0),target:0},{nums:Array.from({length:10000},(_,i)=>i%2? -1:1),target:0},{nums:Array(10000).fill(1),target:5000}]
    for(let i=0;i<12;i++)inputs.push({nums:Array.from({length:integer(0,101)},()=>integer(-10,11)),target:integer(-50,51)})
  }
  return inputs.map((input,i)=>({input,label:i<12?'boundary and contract':'generated contract'}))
}

/** Answers stay on the application server, never in the grader VM payload. */
export function expectedChallengeResult(id: TrustedChallengeId,input: ExtendedDSAInput): unknown {
  const kind=challengeKind(id)
  if(kind==='transform') {
    const nums=input.nums as number[], nonzero=nums.filter(x=>x!==0)
    return [...nonzero,...Array(nums.length-nonzero.length).fill(0)]
  }
  if(kind==='validator') {
    const parts=(input.text as string).split('.')
    return parts.length===4&&parts.every(x=>/^(0|[1-9][0-9]{0,2})$/.test(x)&&Number(x)<=255)
  }
  const counts=new Map<number,number>([[0,1]])
  let sum=0,total=0
  for(const n of input.nums as number[]){sum+=n;total+=counts.get(sum-(input.target as number))??0;counts.set(sum,(counts.get(sum)??0)+1)}
  return total
}
export function judgeChallengeResult(id: TrustedChallengeId,input: DSACase['input'],actual:unknown) {
  return typeof input!=='string'&&isDeepStrictEqual(actual,expectedChallengeResult(id,input))
}
