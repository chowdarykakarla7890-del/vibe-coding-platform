import { browserPackage, milestones, projectBlueprint } from './shared'

export const financeSource=`// Domain layer: no DOM, storage access or global mutable state here.
export function addEntry(entries, input) { throw new Error('Complete the TODO: validate and append an entry') }
export function removeEntry(entries, id) { throw new Error('Complete the TODO: remove one entry') }
export function selectEntries(entries, filters = {}) { throw new Error('Complete the TODO: derive the filtered view') }
export function totals(entries) { throw new Error('Complete the TODO: summarize integer cents') }
export function decodeLedger(raw) { throw new Error('Complete the TODO: validate the versioned saved ledger') }
export function encodeLedger(entries) { throw new Error('Complete the TODO: serialize validated entries') }
`
const html=`<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Personal finance tracker</title></head><body><main>
<h1>Personal finance tracker</h1><p>Learning demo; amounts are integer cents. This is not banking software.</p>
<p id="error" role="alert" hidden></p>
<form id="entry-form"><label>Label<input name="label" required maxlength="80"></label><label>Amount (cents)<input name="amount" type="number" step="1" required></label><label>Category<input name="category" required maxlength="30"></label><button>Add entry</button></form>
<label>Search<input id="search"></label><label>Category filter<input id="category-filter"></label>
<p role="status" id="summary"></p><ul id="entries"></ul><p id="empty">No matching entries</p>
</main><script type="module" src="/src/main.mjs"></script></body></html>`
const view=`import {addEntry,removeEntry,selectEntries,totals,decodeLedger,encodeLedger} from './ledger.mjs'
export function mountLedger(document,storage,makeId=()=>crypto.randomUUID()) {
  const key='codetutor-finance-v1',form=document.querySelector('#entry-form'),error=document.querySelector('#error')
  let entries=[],readable=true
  function showError(message){error.hidden=!message;error.textContent=message}
  try { entries=decodeLedger(storage.getItem(key)) } catch { readable=false;showError('Saved ledger could not be read. Export or repair it before adding entries.') }
  form.querySelector('button').disabled=!readable
  function render(){
    const visible=selectEntries(entries,{query:document.querySelector('#search').value,category:document.querySelector('#category-filter').value})
    const sum=totals(visible),list=document.querySelector('#entries');list.replaceChildren()
    document.querySelector('#summary').textContent=visible.length+' entries · Balance: $'+(sum.balance/100).toFixed(2)
    document.querySelector('#empty').hidden=visible.length!==0
    for(const entry of visible){const li=document.createElement('li'),button=document.createElement('button');li.append(document.createTextNode(entry.label+' · '+entry.category+' · '+entry.amount+' cents '));button.textContent='Delete';button.setAttribute('aria-label','Delete '+entry.label);button.onclick=()=>change(()=>removeEntry(entries,entry.id));li.append(button);list.append(li)}
  }
  function change(next){try {const value=next();storage.setItem(key,encodeLedger(value));entries=value;showError('');render()}catch{showError('Change not saved. Check the fields and storage, then try again.')}}
  function submit(event){event.preventDefault();const fields=form.elements;change(()=>addEntry(entries,{id:makeId(),label:fields.namedItem('label').value,amount:Number(fields.namedItem('amount').value),category:fields.namedItem('category').value}))}
  form.addEventListener('submit',submit)
  document.querySelector('#search').addEventListener('input',render);document.querySelector('#category-filter').addEventListener('input',render)
  render()
  return ()=>{form.removeEventListener('submit',submit);document.querySelector('#search').removeEventListener('input',render);document.querySelector('#category-filter').removeEventListener('input',render)}
}
`
const tests=`import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {JSDOM} from 'jsdom'
import {addEntry,removeEntry,selectEntries,totals,decodeLedger,encodeLedger} from './src/ledger.mjs'
import {mountLedger} from './src/view.mjs'
const a={id:'a',label:'Salary',amount:10000,category:'work'}, b={id:'b',label:'Lunch',amount:-1250,category:'food'}
test('M1 validation, duplicates, removal and immutable input',()=>{
 const old=Object.freeze([Object.freeze(a)]),next=addEntry(old,{...b,label:' Lunch ',category:' food '})
 assert.deepEqual(next,[a,b]);assert.equal(old.length,1);assert.deepEqual(removeEntry(next,'a'),[b]);assert.deepEqual(removeEntry(next,'missing'),next)
 for(const amount of [0,NaN,1.5,Infinity,100000001])assert.throws(()=>addEntry([],{...a,amount}))
 for(const input of [{...a,id:''},{...a,label:' '},{...a,category:''}])assert.throws(()=>addEntry([],input))
 assert.throws(()=>addEntry([a],a));assert.throws(()=>addEntry(Array.from({length:1000},(_,i)=>({...a,id:String(i)})),a))
})
test('M2 composed filters and visible totals',()=>{
 const rows=Object.freeze([Object.freeze(a),Object.freeze(b),Object.freeze({...b,id:'c',amount:-50})])
 assert.deepEqual(selectEntries(rows,{query:' LUN ',category:' food '}),rows.slice(1));assert.deepEqual(selectEntries(rows,{category:'unknown'}),[])
 assert.deepEqual(totals(rows),{income:10000,expense:1300,balance:8700});assert.deepEqual(totals([]),{income:0,expense:0,balance:0})
})
test('M3 strict restore and round trip',()=>{
 assert.deepEqual(decodeLedger(null),[]);assert.deepEqual(decodeLedger(encodeLedger([a,b])),[a,b])
 for(const raw of ['', '{}','null','{"version":2,"entries":[]}',JSON.stringify({version:1,entries:[a,a]}),JSON.stringify({version:1,entries:[{...a,amount:'3'}]})])assert.throws(()=>decodeLedger(raw))
})
test('M4 browser workflow, literal text and persistence failures',()=>{
 const dom=new JSDOM(readFileSync(new URL('./index.html',import.meta.url),'utf8'),{url:'https://example.test'}),d=dom.window.document,storage=dom.window.localStorage
 const dispose=mountLedger(d,storage,()=> 'new');const form=d.querySelector('form')
 for(const [key,value] of Object.entries({label:'<img src=x onerror=alert(1)>',amount:'-200',category:'food'}))form.elements.namedItem(key).value=value
 form.dispatchEvent(new dom.window.Event('submit',{cancelable:true,bubbles:true}))
 assert.equal(d.querySelectorAll('li').length,1);assert.equal(d.querySelectorAll('img').length,0);assert.match(d.querySelector('#summary').textContent,/Balance: \\$-2.00/)
 assert.equal(decodeLedger(storage.getItem('codetutor-finance-v1')).length,1)
 d.querySelector('li button').click();assert.equal(d.querySelectorAll('li').length,0);dispose();dom.window.close()
 const broken=new JSDOM(readFileSync(new URL('./index.html',import.meta.url),'utf8'))
 const doc=broken.window.document;const close=mountLedger(doc,{getItem:()=>null,setItem:()=>{throw Error('quota')}},()=> 'x')
 for(const [key,value] of Object.entries({label:'Book',amount:'100',category:'study'}))doc.querySelector('form').elements.namedItem(key).value=value
 doc.querySelector('form').dispatchEvent(new broken.window.Event('submit',{cancelable:true}));assert.equal(doc.querySelectorAll('li').length,0);assert.equal(doc.querySelector('[role=alert]').hidden,false);close();broken.window.close()
})
`
export const javascriptBlueprint=projectBlueprint({track:'javascript',title:'Personal finance tracker',summary:'Build a browser ledger with integer-cent accounting, composable filters, versioned local persistence and recoverable errors.',concepts:['DOM','modules','validation','persistence','testing'],
 explanation:'Keep business rules independent of the browser. A pure ledger model can be tested without clicks, while the supplied DOM adapter translates forms into model calls. Save before publishing a change so storage failures do not pretend that work was persisted. Integer cents avoid rounding during addition.',
 instructions:[
  'Implement src/ledger.mjs. Entries are {id,label,amount,category}: id is a nonempty string up to 40 characters; trim label (1–80) and category (1–30). amount is a nonzero integer in [-100000000,100000000] cents. Reject duplicates and more than 1,000 entries. Invalid input throws Error.',
  'addEntry returns a new array without mutating existing rows; removeEntry removes the matching ID and is a no-op if absent. selectEntries preserves order, matches trimmed query against label case-insensitively and optional trimmed category exactly. Blank filters mean all.',
  'totals returns {income,expense,balance}; income sums positive amounts, expense is the positive magnitude of negative amounts, balance=income-expense. Empty totals are zero. Summaries in the UI apply to the filtered rows.',
  'encodeLedger/decodeLedger round-trip {version:1,entries:[...]}; null means no saved ledger. Reject malformed JSON, wrong version, invalid rows and duplicate IDs without partially accepting data. Do not access storage in the domain module.',
  'The supplied view.mjs uses text nodes, native controls and an alert for failures. Complete the model, verify add/filter/delete/reload, and preserve its save-before-publish behavior. This is a single-browser educational ledger, not financial advice or a bank integration.',
 ],milestones:milestones([
  {title:'Validate and change the ledger',goal:'Build the immutable domain model before wiring any browser persistence.',acceptance:['Reject invalid amounts and duplicate IDs.','Add and remove entries without changing the caller’s array.']},
  {title:'Derive useful views',goal:'Compose filters and derive summaries from the selected rows.',acceptance:['Apply query and category together.','Correctly handle empty results and negative amounts.']},
  {title:'Persist a versioned document',goal:'Validate restored data with the same rules used for new entries.',acceptance:['Round-trip a valid document.','Reject corrupt or duplicate data without overwriting it.']},
  {title:'Verify the complete browser workflow',goal:'Exercise the supplied UI with real domain calls and failing storage.',acceptance:['Add, filter and delete using labeled controls.','Render labels as text and show failed saves without publishing them.']},
 ],stage=>({executable:'node',args:['--test',`--test-name-pattern=${stage}`,'checks.test.mjs']})),
 hints:['Validate one entry in a helper reused by add and decode.','Filter once, then pass the resulting array to totals.','Do not catch invalid saved data and silently replace it with an empty document.'],
 reflectionQuestions:['Why store integer cents and derive totals instead of persisting a balance?','What happens if localStorage throws during a change, and how do you preserve the last acknowledged state?'],
 examples:[{input:'Salary +10000 cents and Lunch -1250 cents',output:'Income 10000, expense 1250, balance 8750'},{input:'Filter category food',output:'Lunch only; balance -1250'}],
 files:[...browserPackage(),{path:'index.html',content:html},{path:'src/ledger.mjs',content:financeSource},{path:'src/view.mjs',content:view},{path:'src/main.mjs',content:"import {mountLedger} from './view.mjs'\nimport './style.css'\nmountLedger(document,localStorage)\n"},{path:'checks.test.mjs',content:tests}],command:{executable:'npm',args:['test']},preparation:'Run npm install, then npm test. Run npm run dev for the browser preview on port 3000; npm run build checks the production bundle. Dependencies must be reinstalled after source-only restoration.',
})
