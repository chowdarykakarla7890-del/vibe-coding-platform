import { browserPackage, milestones, projectBlueprint } from './shared'

export const boardSource=`export type Status = 'todo' | 'doing' | 'done'
export type Priority = 'high' | 'normal' | 'low'
export type Issue = { id: string; title: string; priority: Priority; status: Status }
export type NewIssue = Omit<Issue, 'status'>
export function createIssue(board: readonly Issue[], input: NewIssue): Issue[] { throw new Error('Complete the TODO: validate a new issue') }
export function moveIssue(board: readonly Issue[], id: string, target: Status): Issue[] { throw new Error('Complete the TODO: enforce workflow transitions') }
export function viewIssues(board: readonly Issue[], filters: { query?: string; status?: Status | 'all' } = {}): {issues: Issue[]; counts: Record<Status,number>} { throw new Error('Complete the TODO: derive sorted issues and global counts') }
export function parseBoard(raw: string | null): Issue[] { throw new Error('Complete the TODO: validate unknown restored data') }
`
const html=`<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Typed issue board</title></head><body><main><h1>Typed issue board</h1><p id="error" role="alert" hidden></p>
<form><label>Issue title<input name="title" required maxlength="80"></label><label>Priority<select name="priority"><option value="normal">Normal</option><option value="high">High</option><option value="low">Low</option></select></label><button>Add issue</button></form>
<label>Search issues<input id="query"></label><label>Status<select id="status"><option value="all">All</option><option value="todo">To do</option><option value="doing">Doing</option><option value="done">Done</option></select></label><p role="status" id="counts"></p><ul id="issues"></ul><p id="empty">No matching issues</p>
</main><script type="module" src="/src/main.ts"></script></body></html>`
const view=`import {createIssue,moveIssue,viewIssues,parseBoard,type Issue,type Priority,type Status} from './board.ts'
export function mountBoard(document:Document,storage:Pick<Storage,'getItem'|'setItem'>,makeId:()=>string=()=>crypto.randomUUID()) {
  const key='codetutor-issues-v1',form=document.querySelector('form')!,error=document.querySelector<HTMLElement>('#error')!
  const query=document.querySelector<HTMLInputElement>('#query')!,status=document.querySelector<HTMLSelectElement>('#status')!
  let board:Issue[]=[],readable=true
  function showError(message:string){error.hidden=!message;error.textContent=message}
  try {board=parseBoard(storage.getItem(key))}catch{readable=false;showError('Saved board is invalid. Preserve it before repairing.')}
  form.querySelector('button')!.disabled=!readable
  function change(next:()=>Issue[]){try{const value=next();storage.setItem(key,JSON.stringify({version:1,issues:value}));board=value;showError('');render()}catch{showError('Change not saved. Check the workflow, fields and storage.')}}
  function render(){
    const result=viewIssues(board,{query:query.value,status:status.value as Status|'all'}),list=document.querySelector('#issues')!;list.replaceChildren()
    document.querySelector('#counts')!.textContent=result.counts.todo+' todo · '+result.counts.doing+' doing · '+result.counts.done+' done'
    document.querySelector<HTMLElement>('#empty')!.hidden=result.issues.length!==0
    for(const issue of result.issues){const row=document.createElement('li'),button=document.createElement('button');row.append(document.createTextNode(issue.title+' · '+issue.priority+' · '+issue.status+' '));const target=issue.status==='todo'?'doing':issue.status==='doing'?'done':'doing';const action=issue.status==='todo'?'Start':issue.status==='doing'?'Complete':'Reopen';button.textContent=action;button.setAttribute('aria-label',action+' '+issue.title);button.onclick=()=>change(()=>moveIssue(board,issue.id,target));row.append(button);list.append(row)}
  }
  function submit(event:Event){event.preventDefault();change(()=>createIssue(board,{id:makeId(),title:(form.elements.namedItem('title') as HTMLInputElement).value,priority:(form.elements.namedItem('priority') as HTMLSelectElement).value as Priority}))}
  form.addEventListener('submit',submit);query.addEventListener('input',render);status.addEventListener('change',render);render()
  return ()=>{form.removeEventListener('submit',submit);query.removeEventListener('input',render);status.removeEventListener('change',render)}
}
`
const tests=`import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {JSDOM} from 'jsdom'
import {createIssue,moveIssue,viewIssues,parseBoard} from './src/board.ts'
import {mountBoard} from './src/view.ts'
const first={id:'a',title:'Fix layout',priority:'high',status:'todo'}
test('M1 validated creation and safe restoration',()=>{
 assert.deepEqual(createIssue([],{id:'a',title:' Fix layout ',priority:'high'}),[first])
 for(const bad of [{id:'',title:'Valid',priority:'high'},{id:'a',title:'x',priority:'high'},{id:'a',title:'Valid',priority:'urgent'}])assert.throws(()=>createIssue([],bad))
 assert.throws(()=>createIssue([first],first));assert.deepEqual(parseBoard(null),[])
 const full=Array.from({length:500},(_,i)=>({...first,id:String(i)}));assert.equal(parseBoard(JSON.stringify({version:1,issues:full})).length,500);assert.throws(()=>createIssue(full,{id:'overflow',title:'Over cap',priority:'normal'}))
 assert.deepEqual(parseBoard(JSON.stringify({version:1,issues:[first]})),[first])
 for(const raw of ['{}','null','bad',JSON.stringify({version:1,issues:[first,first]}),JSON.stringify({version:1,issues:[{...first,status:'closed'}]})])assert.throws(()=>parseBoard(raw))
})
test('M2 transition graph, unknown IDs and immutability',()=>{
 const before=Object.freeze([Object.freeze(first)]),doing=moveIssue(before,'a','doing'),done=moveIssue(doing,'a','done')
 assert.equal(done[0].status,'done');assert.equal(first.status,'todo');assert.equal(moveIssue(done,'a','doing')[0].status,'doing')
 assert.equal(moveIssue(doing,'a','todo')[0].status,'todo');assert.deepEqual(moveIssue(before,'a','todo'),before)
 assert.throws(()=>moveIssue(before,'a','done'));assert.throws(()=>moveIssue(done,'a','todo'));assert.throws(()=>moveIssue(before,'missing','doing'));assert.throws(()=>moveIssue(before,'a','unknown'))
})
test('M3 ordered derived view and counts before filtering',()=>{
 const rows=Object.freeze([first,{id:'z',title:'Docs',priority:'low',status:'done'},{id:'b',title:'Fix focus',priority:'high',status:'doing'}].map(Object.freeze))
 assert.deepEqual(viewIssues(rows).issues.map(x=>x.id),['a','b','z'])
 const result=viewIssues(rows,{query:' FIX ',status:'doing'});assert.deepEqual(result.issues.map(x=>x.id),['b']);assert.deepEqual(result.counts,{todo:1,doing:1,done:1})
 assert.deepEqual(viewIssues([]).counts,{todo:0,doing:0,done:0})
})
test('M4 browser workflow, restored state and failed persistence',()=>{
 const html=readFileSync(new URL('./index.html',import.meta.url),'utf8'),dom=new JSDOM(html,{url:'https://example.test'}),d=dom.window.document,store=dom.window.localStorage
 const stop=mountBoard(d,store,()=> 'issue');d.querySelector('[name=title]').value='Fix keyboard'
 d.querySelector('form').dispatchEvent(new dom.window.Event('submit',{cancelable:true}));assert.match(d.querySelector('#counts').textContent,/1 todo/)
 d.querySelector('li button').click();assert.equal(parseBoard(store.getItem('codetutor-issues-v1'))[0].status,'doing');d.querySelector('li button').click();assert.match(d.querySelector('#counts').textContent,/1 done/)
 stop();const retry=new JSDOM(html);const dispose=mountBoard(retry.window.document,{getItem:()=>store.getItem('codetutor-issues-v1'),setItem:()=>{throw Error('quota')}})
 retry.window.document.querySelector('li button').click();assert.match(retry.window.document.querySelector('#counts').textContent,/1 done/);assert.equal(retry.window.document.querySelector('[role=alert]').hidden,false)
 dispose();retry.window.close();dom.window.close()
})
`
export const typescriptBlueprint=projectBlueprint({track:'typescript',title:'Typed issue board',summary:'Build a typed workflow with validated restoration, guarded transitions, derived views and a browser interface.',concepts:['TypeScript','state machines','validation','derived state','persistence'],
 explanation:'TypeScript helps callers obey a contract, but saved JSON is still unknown data. Validate at the boundary and represent legal states explicitly. Derive sorted views and counts from the canonical issue list; state transitions should produce new records rather than mutating history.',
 instructions:[
  'Implement src/board.ts using the provided types. A board has at most 500 issues. IDs match [a-zA-Z0-9_-]{1,40}; trimmed titles contain 3–80 characters; priority is high, normal or low. createIssue rejects duplicates and starts each issue in todo. Invalid inputs throw Error.',
  'moveIssue allows todo→doing, doing→todo/done, and done→doing. Moving to the current state is a no-op; unknown IDs, states or other transitions throw. Never mutate caller arrays or records.',
  'viewIssues filters by trimmed case-insensitive title query and optional status (all by default). Sort high, normal, low, then ID ascending using code-unit order. Return {issues,counts}; counts always cover the entire board before filtering.',
  'parseBoard accepts null as an empty board; otherwise validate {version:1,issues:[...]}, every field, unique IDs and the 500-item cap. Reject malformed or partially valid documents. The provided browser adapter saves a complete document before publishing a change.',
  'Retain the browser add/start/complete/reopen controls, query/status filters and failure alerts. Run strict type checking as well as behavioral tests: Node type stripping does not type-check your solution.',
 ],milestones:milestones([
  {title:'Define the typed boundary',goal:'Implement validated creation and safe decoding from unknown saved JSON.',acceptance:['Reject duplicate IDs and invalid restored states.','Keep strict TypeScript checks passing.']},
  {title:'Enforce the workflow',goal:'Represent legal issue transitions without mutating past state.',acceptance:['Test every permitted edge and at least two forbidden edges.','Reject unknown issue IDs.']},
  {title:'Build derived views',goal:'Combine filters, stable ordering and global status counts.',acceptance:['Sort by priority then ID.','Filtering does not change global counts or input order.']},
  {title:'Connect and recover the browser board',goal:'Verify the supplied UI through persistence and reload, including storage failure.',acceptance:['Create and complete an issue through native buttons.','Keep the last saved board when a persistence attempt fails.']},
 ],stage=>({executable:'node',args:['--test',`--test-name-pattern=${stage}`,'checks.test.mjs']})),
 hints:['Decode unknown objects field by field rather than casting JSON to Issue[].','Use a transition table or exhaustive status cases.','Sort a copy and compute counts separately from the filtered view.'],reflectionQuestions:['Where do static types stop protecting this application?','Why should filtered counts and full-board counts be separate concepts?'],examples:[{input:'todo → done',output:'Rejected; move through doing first'},{input:'One todo and one done; filter done',output:'One visible issue; global counts still show one todo and one done'}],
 files:[...browserPackage(true),{path:'index.html',content:html},{path:'src/board.ts',content:boardSource},{path:'src/view.ts',content:view},{path:'src/main.ts',content:"import {mountBoard} from './view.ts'\nimport './style.css'\nmountBoard(document,localStorage)\n"},{path:'checks.test.mjs',content:tests}],command:{executable:'npm',args:['test']},preparation:'Run npm install, npm run typecheck and npm test. Run npm run dev for port 3000 or npm run build for a production bundle. Reinstall dependencies after source-only restoration.',
})
