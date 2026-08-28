import type { ActivityManifest } from '../types'

export type BlueprintTrack = 'javascript' | 'typescript' | 'react' | 'python' | 'java' | 'cpp'
export interface BlueprintSpec {
  track: BlueprintTrack
  title: string
  summary: string
  concepts: string[]
  instructions: string[]
  explanation: string
  milestones: NonNullable<ActivityManifest['milestones']>
  hints: string[]
  reflectionQuestions: string[]
  examples: { input: string; output: string }[]
  files: { path: string; content: string }[]
  command: { executable: string; args: string[] }
  preparation: string
}
const languages = { javascript: 'JavaScript', typescript: 'TypeScript', react: 'JavaScript', python: 'Python', java: 'Java', cpp: 'C++' }

export function projectBlueprint(spec: BlueprintSpec): ActivityManifest {
  const instructions=[...spec.instructions,spec.preparation,
    'Follow the four milestones in order. Keep the visible checks and add an edge case. Record commands, results and decisions in MILESTONES.md; this is a learner checklist, not an automatic progress or score claim.',
    'Save your implementation and REFLECTION.md, then Submit for AI-assessed rubric feedback. Editable checks are teaching aids, not server-trusted grading.']
  const milestoneText=spec.milestones.map((item,i)=>`## ${i+1}. ${item.title}\n\n${item.goal}\n\n${item.acceptance.map(text=>`- [ ] ${text}`).join('\n')}\n\nCheck: \`${[item.check.executable,...item.check.args].join(' ')}\`\n\nEvidence and decisions: TODO\n`).join('\n')
  return {id:`project-${spec.track}-blueprint`,mode:'project',title:spec.title,summary:spec.summary,
    language:languages[spec.track],...(spec.track==='react'?{framework:'React'}:{}),difficulty:'intermediate',estimatedMinutes:180,
    concepts:spec.concepts,instructions,milestones:spec.milestones,
    lesson:{explanation:spec.explanation,hints:spec.hints,reflectionQuestions:spec.reflectionQuestions},examples:spec.examples,
    starterFiles:[...spec.files,
      {path:'LESSON.md',content:`# ${spec.title}\n\n${spec.explanation}\n\n## Contract\n\n${instructions.map((x,i)=>`${i+1}. ${x}`).join('\n\n')}\n\n## Examples\n\n${spec.examples.map(x=>`- ${x.input} → ${x.output}`).join('\n')}\n\n## Hints\n\n${spec.hints.map((x,i)=>`### Hint ${i+1}\n\n${x}`).join('\n\n')}\n`},
      {path:'MILESTONES.md',content:`# Project milestones\n\nMark these yourself after checking the evidence. Checked boxes do not award a score.\n\n${milestoneText}`},
      {path:'REFLECTION.md',content:`# Reflection\n\n${spec.reflectionQuestions.map(x=>`## ${x}\n\nTODO: Explain your decision and give a concrete example.`).join('\n\n')}\n`},
    ],verify:{kind:'command',command:spec.command},source:'curated',rubric:[
      {id:'behavior',label:'Implements the complete stated workflow, including failure and boundary behavior',weight:50},
      {id:'design',label:'Separates domain logic, interface and persistence with clear data contracts',weight:20},
      {id:'checks',label:'Retains meaningful checks and records milestone evidence plus an added edge case',weight:20},
      {id:'reflection',label:'Explains a tradeoff and a failure-recovery decision with concrete examples',weight:10},
    ]}
}

export function milestones(items: { title:string; goal:string; acceptance:string[] }[], command:(stage:string)=>{executable:string;args:string[]}): NonNullable<ActivityManifest['milestones']> {
  return items.map((item,index)=>({...item,id:`m${index+1}`,check:command(`M${index+1}`)}))
}

export const browserStyle=`:root{font-family:system-ui,sans-serif;color-scheme:light dark}body{margin:0}main{max-width:48rem;margin:2rem auto;padding:1rem}form{display:grid;gap:.6rem}input,select,button{font:inherit;padding:.6rem}li{margin:.7rem 0;overflow-wrap:anywhere}button{cursor:pointer}label{display:grid;gap:.3rem}:focus-visible{outline:3px solid currentColor;outline-offset:3px}[role=alert]{border:1px solid;padding:.7rem}@media(max-width:480px){main{margin:0}}`

export function browserPackage(typescript=false) {
  return [
    {path:'package.json',content:JSON.stringify({private:true,type:'module',scripts:{dev:'vite --host 0.0.0.0 --port 3000',build:'vite build',test:'node --test checks.test.mjs',...(typescript?{typecheck:'tsc --noEmit'}:{})},devDependencies:{vite:'8.2.2',jsdom:'30.0.1',...(typescript?{typescript:'5.9.3'}:{})}},null,2)+'\n'},
    {path:'src/style.css',content:browserStyle},
    ...(typescript?[{path:'tsconfig.json',content:JSON.stringify({compilerOptions:{target:'ES2022',module:'NodeNext',strict:true,noEmit:true,skipLibCheck:true,lib:['ES2022','DOM'],allowImportingTsExtensions:true},include:['src/*.ts']},null,2)+'\n'}]:[]),
  ]
}
