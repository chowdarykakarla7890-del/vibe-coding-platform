import { challengeContracts, challengeKind, challengeLanguage, type TrustedChallengeId } from '@/lib/learning/challenges/contracts'
import { dsaTypes } from '@/lib/learning/dsa-extended'

// Independent test-only implementations. Never imported by catalog or grader.
const bodies={
  transform:{
    js:'const out=Array(nums.length).fill(0);let at=0;for(const n of nums)if(n!==0)out[at++]=n;return out;',
    py:'out=[0]*len(nums)\nat=0\nfor n in nums:\n    if n!=0:\n        out[at]=n\n        at+=1\nreturn out',
    java:'int[] out=new int[nums.length];int at=0;for(int n:nums)if(n!=0)out[at++]=n;return out;',
    cpp:'vector<int>out(nums.size());size_t at=0;for(int n:nums)if(n!=0)out[at++]=n;return out;',
  },
  validator:{
    js:'const parts=text.split(".");if(parts.length!==4)return false;return parts.every(p=>{if(p.length<1||p.length>3||(p.length>1&&p[0]==="0"))return false;let n=0;for(const c of p){if(c<"0"||c>"9")return false;n=n*10+c.charCodeAt(0)-48;}return n<=255;});',
    py:'parts=text.split(".")\nif len(parts)!=4: return False\nfor p in parts:\n    if not 1<=len(p)<=3 or (len(p)>1 and p[0]=="0"): return False\n    n=0\n    for c in p:\n        if not "0"<=c<="9": return False\n        n=n*10+ord(c)-48\n    if n>255: return False\nreturn True',
    java:'String[] parts=text.split("[.]",-1);if(parts.length!=4)return false;for(String p:parts){if(p.isEmpty()||p.length()>3||(p.length()>1&&p.charAt(0)==\'0\'))return false;int n=0;for(char c:p.toCharArray()){if(c<\'0\'||c>\'9\')return false;n=n*10+c-\'0\';}if(n>255)return false;}return true;',
    cpp:'vector<string>parts(1);for(char c:text){if(c==\'.\')parts.push_back("");else parts.back()+=c;}if(parts.size()!=4)return false;for(auto&p:parts){if(p.empty()||p.size()>3||(p.size()>1&&p[0]==\'0\'))return false;int n=0;for(char c:p){if(c<\'0\'||c>\'9\')return false;n=n*10+c-\'0\';}if(n>255)return false;}return true;',
  },
  performance:{
    js:'const frequency=new Map();let prefix=0,result=0;for(const n of nums){frequency.set(prefix,(frequency.get(prefix)??0)+1);prefix+=n;result+=frequency.get(prefix-target)??0;}return result;',
    py:'frequency={}\nprefix=0\nresult=0\nfor n in nums:\n    frequency[prefix]=frequency.get(prefix,0)+1\n    prefix+=n\n    result+=frequency.get(prefix-target,0)\nreturn result',
    java:'Map<Integer,Integer>freq=new HashMap<>();int prefix=0,result=0;for(int n:nums){freq.merge(prefix,1,Integer::sum);prefix+=n;result+=freq.getOrDefault(prefix-target,0);}return result;',
    cpp:'unordered_map<int,int>frequency;int prefix=0,result=0;for(int n:nums){frequency[prefix]++;prefix+=n;result+=frequency[prefix-target];}return result;',
  },
}
export function challengeSolution(id:TrustedChallengeId) {
  const language=challengeLanguage(id),spec=challengeContracts[challengeKind(id)],body=bodies[challengeKind(id)],types=dsaTypes[language]
  if(language==='Python')return `def solve(value):\n${spec.fields.map(f=>`    ${f.name}=value["${f.name}"]`).join('\n')}\n${body.py.split('\n').map(line=>'    '+line).join('\n')}\n`
  if(language==='Java')return `import java.util.*;\npublic class Main{public static ${types[spec.result]} solve(${spec.fields.map(f=>`${types[f.type]} ${f.name}`).join(',')}){${body.java}}}\n`
  if(language==='C++')return `#include <vector>\n#include <string>\n#include <unordered_map>\nusing namespace std;\n${types[spec.result]} solve(${spec.fields.map(f=>f.type==='integer'?`int ${f.name}`:`const ${types[f.type]}& ${f.name}`).join(',')}){${body.cpp}}\n`
  return `export function solve(value${language==='TypeScript'?`: {${spec.fields.map(f=>`${f.name}:${types[f.type]}`).join(';')}}`:''}){const {${spec.fields.map(f=>f.name).join(',')}}=value;${body.js}}\n`
}

export const reactChallengeSolutions:Record<string,string>={
  'challenge-react-transform':`import React from 'react'\nconst initialItems=[{id:'pen',name:'Pen',cents:125,quantity:2}]\nexport default function App({items=initialItems}){const rows=items.filter(x=>x.quantity>0);const total=rows.reduce((sum,x)=>sum+x.cents*x.quantity,0);return <main>{rows.length?<ul>{rows.map(x=><li key={x.id}>{x.name} × {x.quantity}</li>)}</ul>:<p>Your basket is empty</p>}<p role="status">Total: $${'{'}(total/100).toFixed(2)}</p></main>}\n`,
  'challenge-react-validator':`import React,{useRef,useState}from'react'\nexport default function App({onJoin=()=>{}}){const[value,setValue]=useState(''),[error,setError]=useState(false),[joined,setJoined]=useState('');const input=useRef(null);function submit(e){e.preventDefault();if(!/^[A-Za-z][A-Za-z0-9_]{2,11}$/.test(value)){setError(true);setJoined('');input.current.focus();return;}setError(false);onJoin(value);setJoined(value);}return <form onSubmit={submit}><label htmlFor="username">Username</label><input ref={input} id="username" value={value} aria-invalid={error} aria-describedby={error?'username-error':undefined} onChange={e=>{setValue(e.target.value);setError(false);setJoined('');}}/><button type="submit">Join</button>{error?<p role="alert" id="username-error">Use 3–12 characters, starting with a letter; letters, digits and _ only.</p>:null}{joined?<p role="status">Joined as {joined}</p>:null}</form>}\n`,
  'challenge-react-performance':`import React,{useMemo,useState}from'react'\nconst initialItems=[1,2,3],initialCalculate=items=>items.reduce((a,b)=>a+b,0);export default function App({items=initialItems,calculate=initialCalculate}){const[open,setOpen]=useState(false);const report=useMemo(()=>calculate(items),[items,calculate]);return <main><p role="status">Report: {report}</p><button onClick={()=>setOpen(value=>!value)}>Toggle details</button>{open?<p>Details are open</p>:null}</main>}\n`,
}
