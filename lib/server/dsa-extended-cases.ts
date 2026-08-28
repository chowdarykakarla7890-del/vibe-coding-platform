import 'server-only'
import { extendedSpecification, type ExtendedDSAId, type ExtendedDSAInput } from '@/lib/learning/dsa-extended'

type Integer = (min: number, max: number) => number
const boundaries: Record<ExtendedDSAId, ExtendedDSAInput[]> = {
  'dsa-python-merge-intervals': [{ intervals: [[0,0]] }, { intervals: [[1,1],[2,2]] }, { intervals: [[1,9],[2,3]] }, { intervals: [[1,2],[1,2]] }, { intervals: [[-3,-1],[-1,0]] }, { intervals: [[-1000,1000]] }, { intervals: [[5,7],[2,4]] }, { intervals: [[3,4],[1,2],[2,3]] }, { intervals: Array.from({ length: 20 }, (_, i) => [i*2,i*2]) }],
  'dsa-python-longest-substring': [{ text: 'a' }, { text: 'aaaa' }, { text: 'dvdf' }, { text: 'tmmzuxt' }, { text: 'pwwkew' }, { text: 'abcdefghijklmnopqrstuvwxyz' }, { text: 'a'.repeat(200) }, { text: 'abcde'.repeat(40) }, { text: 'abcadbef' }],
  'dsa-python-tree-level-order': [{ tree: [null] }, { tree: [0] }, { tree: [1,2,3] }, { tree: [1,2,null,3] }, { tree: [1,null,2,null,3] }, { tree: [1,2,3,null,4,5] }, { tree: [0,0,0] }, { tree: [-50,50,-50] }, { tree: Array.from({ length: 63 }, (_, i) => i % 50) }],
  'dsa-python-number-islands': [{ grid: [''] }, { grid: ['',''] }, { grid: ['0'] }, { grid: ['1'] }, { grid: ['11111'] }, { grid: ['1','0','1'] }, { grid: ['111','101','111'] }, { grid: Array(12).fill('1'.repeat(12)) }, { grid: Array.from({ length: 12 }, (_, i) => '01'.repeat(6).split('').map((c,j) => String((i+j)%2)).join('')) }],
  'dsa-python-coin-change': [{ coins: [], amount: 1 }, { coins: [1], amount: 200 }, { coins: [50], amount: 200 }, { coins: [2,4], amount: 7 }, { coins: [2,2,3], amount: 7 }, { coins: [7], amount: 0 }, { coins: [3,5], amount: 7 }, { coins: [2,5,10], amount: 6 }, { coins: [1,7,10], amount: 14 }],
  'dsa-python-top-k': [{ nums: [], k: 4 }, { nums: [1,2,3], k: 3 }, { nums: [-2,-2,-3], k: 2 }, { nums: [4,4,4], k: 5 }, { nums: [2,1,2,1,3,3], k: 2 }, { nums: Array(80).fill(20), k: 1 }, { nums: [-20,20,0], k: 50 }, { nums: [0,0,1,1,1], k: 1 }, { nums: [3,2,1], k: 0 }],
  'dsa-python-linked-cycle': [{ next: [0], head: 0 }, { next: [-1], head: 0 }, { next: [0], head: -1 }, { next: [1,-1], head: 0 }, { next: [1,0], head: 0 }, { next: [-1,1], head: 1 }, { next: [2,-1,1], head: 0 }, { next: Array.from({ length: 80 }, (_, i) => i === 79 ? -1 : i+1), head: 0 }, { next: Array.from({ length: 80 }, (_, i) => (i+1)%80), head: 0 }],
  'dsa-python-word-break': [{ text: 'a', words: [] }, { text: 'a', words: ['a'] }, { text: 'aaaaaaa', words: ['aaaa','aaa'] }, { text: 'cars', words: ['car','ca','rs'] }, { text: 'applepenapple', words: ['apple','pen'] }, { text: 'a'.repeat(39)+'b', words: ['a','aa','aaa','aaaa'] }, { text: 'a'.repeat(40), words: ['aa','aaaa'] }, { text: '', words: ['a'] }, { text: 'abcabc', words: ['abc','abc'] }],
  'dsa-python-course-schedule': [{ numCourses: 1, prerequisites: [] }, { numCourses: 1, prerequisites: [[0,0]] }, { numCourses: 2, prerequisites: [[1,0],[1,0]] }, { numCourses: 4, prerequisites: [[2,3],[3,2]] }, { numCourses: 3, prerequisites: [[1,0],[2,1],[2,0]] }, { numCourses: 12, prerequisites: [] }, { numCourses: 12, prerequisites: Array.from({ length: 11 }, (_, i) => [i+1,i]) }, { numCourses: 12, prerequisites: Array.from({ length: 12 }, (_, i) => [(i+1)%12,i]) }, { numCourses: 4, prerequisites: [[1,0],[2,0],[3,1],[3,2]] }],
  'dsa-python-lru-cache': [{ capacity: 1, operations: [[0,1]] }, { capacity: 1, operations: [[1,1,1],[1,1,2],[0,1]] }, { capacity: 1, operations: [[1,1,1],[1,2,2],[0,1],[0,2]] }, { capacity: 2, operations: [[1,1,1],[1,2,2],[1,1,3],[1,3,3],[0,2],[0,1]] }, { capacity: 2, operations: [[1,1,1],[1,2,2],[0,9],[1,3,3],[0,1],[0,2]] }, { capacity: 8, operations: [[1,-9,-100],[0,-9]] }, { capacity: 1, operations: [[1,0,-1],[0,0]] }, { capacity: 0, operations: [[0,0],[0,1]] }, { capacity: 1, operations: Array.from({ length: 40 }, (_, i) => i%2 ? [0,1] : [1,1,i]) }],
  'dsa-python-median-stream': [{ nums: [0] }, { nums: [1,2] }, { nums: [1,1,1] }, { nums: [-1000,1000] }, { nums: [3,2,1] }, { nums: [1,2,3,4,5] }, { nums: [1000,-1000,1000,-1000] }, { nums: Array(32).fill(-999) }, { nums: Array.from({ length: 32 }, (_, i) => i-16) }],
  'dsa-python-edit-distance': [{ source: '', target: '' }, { source: 'abc', target: '' }, { source: 'same', target: 'same' }, { source: 'a', target: 'b' }, { source: 'horse', target: 'ros' }, { source: 'intention', target: 'execution' }, { source: 'a'.repeat(40), target: 'b'.repeat(40) }, { source: 'a'.repeat(40), target: 'a' }, { source: 'abcdef', target: 'azced' }],
}

export function extendedCases(id: ExtendedDSAId, integer: Integer) {
  const inputs = [...extendedSpecification(id).examples.map(example => structuredClone(example.input)), ...structuredClone(boundaries[id])]
  const nums = (n: number, min = -20, max = 21) => Array.from({ length: n }, () => integer(min,max))
  const text = (max: number) => nums(integer(0,max+1),0,5).map(n => 'abcde'[n]).join('')
  for (let i = 0; i < 12; i++) {
    let value: ExtendedDSAInput
    switch (id) {
      case 'dsa-python-merge-intervals': value = { intervals: Array.from({ length: integer(0,21) }, () => { const a=integer(-1000,1001), b=integer(-1000,1001); return [Math.min(a,b),Math.max(a,b)] }) }; break
      case 'dsa-python-longest-substring': value = { text: text(200) }; break
      case 'dsa-python-tree-level-order': {
        const tree: (number|null)[] = [integer(-50,51)]
        let pending = 1
        while (pending && tree.length < 63) {
          pending--
          for (let j=0;j<2 && tree.length<63;j++) { const child=integer(0,4)===0 ? null : integer(-50,51); tree.push(child); if(child!==null)pending++ }
        }
        value={tree}; break
      }
      case 'dsa-python-number-islands': { const rows=integer(0,13), width=integer(0,13); value={ grid: Array.from({length:rows},()=>nums(width,0,2).join('')) }; break }
      case 'dsa-python-coin-change': value={ coins:nums(integer(0,13),1,51), amount:integer(0,201) }; break
      case 'dsa-python-top-k': value={ nums:nums(integer(0,81)), k:integer(0,51) }; break
      case 'dsa-python-linked-cycle': { const n=integer(0,81); value={ next:nums(n,-1,n), head:n ? integer(-1,n) : -1 }; break }
      case 'dsa-python-word-break': { const words=Array.from({length:integer(0,21)},()=>text(7)+'a'); value={ text: i%2 && words.length ? Array.from({length:integer(1,6)},()=>words[integer(0,words.length)]).join('').slice(0,40) : text(40), words }; break }
      case 'dsa-python-course-schedule': { const n=integer(0,13); value={ numCourses:n, prerequisites:n ? Array.from({length:integer(0,41)},()=>[integer(0,n),integer(0,n)]) : [] }; break }
      case 'dsa-python-lru-cache': value={ capacity:integer(0,9), operations:Array.from({length:integer(0,41)},()=>integer(0,2) ? [1,integer(-9,10),integer(-100,101)] : [0,integer(-9,10)]) }; break
      case 'dsa-python-median-stream': value={ nums:nums(integer(0,33),-1000,1001) }; break
      case 'dsa-python-edit-distance': value={ source:text(40), target:text(40) }; break
    }
    inputs.push(value)
  }
  return inputs.map((input,index) => ({ input, label:index<12 ? 'contract boundaries' : 'generated cases' }))
}

/** These inputs are produced by the server registry, never accepted from a learner. */
export function expectedExtendedResult(id: ExtendedDSAId, input: ExtendedDSAInput): unknown {
  const number = (key: string) => input[key] as number
  const text = (key: string) => input[key] as string
  const array = (key: string) => input[key] as number[]
  const matrix = (key: string) => input[key] as number[][]
  const strings = (key: string) => input[key] as string[]
  switch (id) {
    case 'dsa-python-merge-intervals': {
      const result: number[][]=[]
      for (const [a,b] of matrix('intervals').map(row=>[...row]).sort((a,b)=>a[0]-b[0])) {
        const last=result.at(-1)
        if(last && a<=last[1])last[1]=Math.max(last[1],b); else result.push([a,b])
      }
      return result
    }
    case 'dsa-python-longest-substring': {
      const s=text('text'); let longest=0
      for(let left=0;left<s.length;left++){const seen=new Set<string>();for(let right=left;right<s.length&&!seen.has(s[right]);right++){seen.add(s[right]);longest=Math.max(longest,seen.size)}}
      return longest
    }
    case 'dsa-python-tree-level-order': {
      const tree=input.tree as (number|null)[]
      if(!tree.length || tree[0]===null)return []
      const result:number[][]=[]; let level:number[]=[tree[0]], index=1
      while(level.length){result.push(level);const next:number[]=[];for(let i=0;i<level.length;i++)for(let j=0;j<2&&index<tree.length;j++){const value=tree[index++];if(value!==null)next.push(value)}level=next}
      return result
    }
    case 'dsa-python-number-islands': {
      const grid=strings('grid').map(row=>row.split('')); let count=0
      for(let r=0;r<grid.length;r++)for(let c=0;c<grid[r].length;c++)if(grid[r][c]==='1'){
        count++;const stack=[[r,c]];grid[r][c]='0'
        while(stack.length){const [y,x]=stack.pop()!;for(const [dy,dx] of [[-1,0],[1,0],[0,-1],[0,1]])if(grid[y+dy]?.[x+dx]==='1'){grid[y+dy][x+dx]='0';stack.push([y+dy,x+dx])}}
      }
      return count
    }
    case 'dsa-python-coin-change': {
      const amount=number('amount'), dp=Array<number>(amount+1).fill(Infinity);dp[0]=0
      for(let sum=1;sum<=amount;sum++)for(const coin of array('coins'))if(coin<=sum)dp[sum]=Math.min(dp[sum],dp[sum-coin]+1)
      return Number.isFinite(dp[amount])?dp[amount]:-1
    }
    case 'dsa-python-top-k': {
      const counts=new Map<number,number>();for(const value of array('nums'))counts.set(value,(counts.get(value)??0)+1)
      return [...counts.keys()].sort((a,b)=>counts.get(b)!-counts.get(a)!||a-b).slice(0,number('k'))
    }
    case 'dsa-python-linked-cycle': {
      const seen=new Set<number>(), next=array('next');let node=number('head')
      while(node!==-1){if(seen.has(node))return true;seen.add(node);node=next[node]}return false
    }
    case 'dsa-python-word-break': {
      const s=text('text'), reachable=new Set([0])
      for(let i=0;i<=s.length;i++)if(reachable.has(i))for(const word of strings('words'))if(s.startsWith(word,i))reachable.add(i+word.length)
      return reachable.has(s.length)
    }
    case 'dsa-python-course-schedule': {
      const n=number('numCourses'), dependencies=Array.from({length:n},()=>new Set<number>())
      for(const [course,required] of matrix('prerequisites'))dependencies[course].add(required)
      const completed=new Set<number>();let changed=true
      while(changed){changed=false;for(let c=0;c<n;c++)if(!completed.has(c)&&[...dependencies[c]].every(d=>completed.has(d))){completed.add(c);changed=true}}
      return completed.size===n
    }
    case 'dsa-python-lru-cache': {
      const values=new Map<number,number>(), results:number[]=[]
      for(const [kind,key,value] of matrix('operations')){
        if(kind===0){const found=values.get(key);results.push(found??-1);if(values.has(key)){values.delete(key);values.set(key,found!)}}
        else {values.delete(key);values.set(key,value);if(values.size>number('capacity'))values.delete(values.keys().next().value!)}
      }
      return results
    }
    case 'dsa-python-median-stream': {
      const prefix:number[]=[], medians:number[]=[]
      for(const value of array('nums')){prefix.push(value);prefix.sort((a,b)=>a-b);const mid=Math.floor(prefix.length/2);medians.push(prefix.length%2?prefix[mid]:(prefix[mid-1]+prefix[mid])/2)}return medians
    }
    case 'dsa-python-edit-distance': {
      const a=text('source'), b=text('target');let row=Array.from({length:b.length+1},(_,i)=>i)
      for(let i=1;i<=a.length;i++){const next=[i];for(let j=1;j<=b.length;j++)next[j]=Math.min(row[j]+1,next[j-1]+1,row[j-1]+Number(a[i-1]!==b[j-1]));row=next}return row[b.length]
    }
  }
}
