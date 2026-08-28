import { reactLessonFiles } from '../practice/react'
import { milestones, projectBlueprint } from './shared'

// The adapter is supplied; learners implement the stateful interface, not a cloud service.
export const habitStorage = `export function validateHabits(value) {
  if(!Array.isArray(value)||value.length>100)throw Error('Invalid habits')
  const ids=new Set(),labels=new Set()
  return value.map(row=>{
    if(!row||typeof row.id!=='string'||!/^[a-zA-Z0-9_-]{1,40}$/.test(row.id)||typeof row.label!=='string')throw Error('Invalid habit')
    const label=row.label.trim(),key=label.toLowerCase()
    if(!label||label.length>80||ids.has(row.id)||labels.has(key)||!Array.isArray(row.days)||row.days.length>3660||new Set(row.days).size!==row.days.length)throw Error('Invalid habit')
    for(const day of row.days){if(typeof day!=='string'||!/^\\d{4}-\\d{2}-\\d{2}$/.test(day)||day.startsWith('0000')||!Number.isFinite(Date.parse(day))||new Date(day).toISOString().slice(0,10)!==day)throw Error('Invalid day')}
    ids.add(row.id);labels.add(key);return {id:row.id,label,days:[...row.days]}
  })
}
const key='codetutor-habits-v1'
export async function loadHabits(signal) {
  signal.throwIfAborted()
  const raw=localStorage.getItem(key)
  if(raw===null)return []
  const value=JSON.parse(raw)
  if(!value||value.version!==1)throw Error('Invalid saved habits')
  return validateHabits(value.habits)
}
export async function saveHabits(habits,signal) {
  signal.throwIfAborted()
  localStorage.setItem(key,JSON.stringify({version:1,habits:validateHabits(habits)}))
}
`
export const habitSource = `import React, {useEffect,useRef,useState} from 'react'
import {loadHabits,saveHabits,validateHabits} from './storage.js'
const newId=()=>crypto.randomUUID()
export default function App({load=loadHabits,save=saveHabits,today=new Date().toISOString().slice(0,10),makeId=newId}) {
  // TODO: implement loading, validated edits, completion and acknowledged persistence.
  throw new Error('Complete the TODO before submitting')
}
`
const checks = `import {validateHabits,loadHabits,saveHabits} from './src/storage.js'
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}}
const today='2026-04-01',row={id:'read',label:'Read',days:[]}
const ready=()=>screen.findByLabelText('Habit name')
const add=label=>{fireEvent.change(screen.getByLabelText('Habit name'),{target:{value:label}});fireEvent.click(screen.getByRole('button',{name:'Add habit'}))}
test('M1 supplied storage adapter validates the complete versioned document',async()=>{
 localStorage.clear();const controller=new AbortController()
 expect(await loadHabits(controller.signal)).toEqual([])
 await saveHabits([row],controller.signal);expect(await loadHabits(controller.signal)).toEqual([row])
 for(const habits of [[row,row],[row,{...row,id:'other',label:' READ '}],[{...row,days:['2026-02-29']}],[{...row,days:[today,today]}],Array.from({length:101},(_,i)=>({id:String(i),label:String(i),days:[]}))])expect(()=>validateHabits(habits)).toThrow()
 localStorage.setItem('codetutor-habits-v1','{"version":2,"habits":[]}')
 await expect(loadHabits(controller.signal)).rejects.toThrow();expect(localStorage.getItem('codetutor-habits-v1')).toContain('"version":2')
 controller.abort();await expect(saveHabits([],controller.signal)).rejects.toThrow();localStorage.clear()
})
test('M1 loading, empty, rejected load and explicit retry',async()=>{
 const pending=deferred(),load=vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce([])
 render(<App load={load} save={vi.fn()} today={today}/>)
 expect(screen.getByRole('status').textContent).toBe('Loading habits…')
 await act(async()=>pending.reject(Error('unavailable')))
 expect(screen.getByRole('alert').textContent).toBe('Could not load habits')
 expect(screen.queryByLabelText('Habit name')).toBeNull()
 fireEvent.click(screen.getByRole('button',{name:'Retry loading'}));await ready()
 expect(screen.getByText('No habits yet')).toBeTruthy();expect(load).toHaveBeenCalledTimes(2)
})
test('M1 rejects invalid restored rows rather than overwriting them',async()=>{
 const save=vi.fn();render(<App load={async()=>[row,row]} save={save} today={today}/>)
 await screen.findByRole('alert');expect(screen.queryByLabelText('Habit name')).toBeNull();expect(save).not.toHaveBeenCalled()
})
test('M2 add, validate, render literal text and delete',async()=>{
 const save=vi.fn().mockResolvedValue(undefined)
 render(<App load={async()=>[]} save={save} today={today} makeId={()=>'one'}/>);await ready()
 add('  <img src=x>  ');await waitFor(()=>expect(screen.getAllByRole('listitem')).toHaveLength(1))
 expect(document.querySelector('img')).toBeNull();expect(save.mock.calls[0][0]).toEqual([{id:'one',label:'<img src=x>',days:[]}])
 add('<IMG SRC=X>');await screen.findByRole('alert');expect(save).toHaveBeenCalledTimes(1)
 fireEvent.click(screen.getByRole('button',{name:'Delete <img src=x>'}));await waitFor(()=>expect(screen.queryAllByRole('listitem')).toHaveLength(0))
 expect(save.mock.calls[1][0]).toEqual([])
})
test('M3 toggle today while preserving historical days and input props',async()=>{
 const original=Object.freeze([{...row,days:Object.freeze(['2026-03-31'])}]),save=vi.fn().mockResolvedValue(undefined)
 render(<App load={async()=>original} save={save} today={today}/>);await ready()
 fireEvent.click(screen.getByRole('button',{name:'Mark Read today'}));await screen.findByRole('button',{name:'Unmark Read today'})
 expect(screen.getByRole('status').textContent).toBe('1 habits · 1 completed today')
 expect(save.mock.calls[0][0][0].days).toEqual(['2026-03-31',today])
 fireEvent.click(screen.getByRole('button',{name:'Unmark Read today'}));await screen.findByRole('button',{name:'Mark Read today'})
 expect(save.mock.calls[1][0][0].days).toEqual(['2026-03-31']);expect(original[0].days).toEqual(['2026-03-31'])
})
test('M4 publish only acknowledged saves, keep failed drafts and allow retry',async()=>{
 const pending=deferred(),save=vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(undefined)
 render(<App load={async()=>[]} save={save} today={today} makeId={()=>'one'}/>);await ready();add('Study')
 expect(screen.getByRole('button',{name:'Add habit'}).disabled).toBe(true)
 expect(screen.queryAllByRole('listitem')).toHaveLength(0)
 fireEvent.click(screen.getByRole('button',{name:'Add habit'}));expect(save).toHaveBeenCalledTimes(1)
 await act(async()=>pending.reject(Error('quota')))
 expect(screen.getByRole('alert').textContent).toBe('Change not saved. Try again.')
 expect(screen.getByLabelText('Habit name').value).toBe('Study');expect(screen.queryAllByRole('listitem')).toHaveLength(0)
 fireEvent.click(screen.getByRole('button',{name:'Add habit'}));await screen.findByRole('listitem');expect(screen.getByLabelText('Habit name').value).toBe('')
})
test('M4 late load cannot replace a newer source; unmount aborts pending work',async()=>{
 const old=deferred(),load=vi.fn(()=>old.promise),save=vi.fn()
 const view=render(<App load={load} save={save} today={today}/>)
 view.rerender(<App load={async()=>[row]} save={save} today={today}/>);await ready()
 await act(async()=>old.resolve([]));expect(screen.getByRole('listitem').textContent).toContain('Read');expect(load.mock.calls[0][0].aborted).toBe(true)
 view.unmount()
 const pending=deferred(),saving=vi.fn(()=>pending.promise)
 const next=render(<App load={async()=>[]} save={saving} today={today} makeId={()=>'one'}/>);await ready();add('Read');next.unmount()
 expect(saving.mock.calls[0][1].aborted).toBe(true);await act(async()=>pending.resolve())
})
`
export const reactBlueprint=projectBlueprint({track:'react',title:'Accessible habit coach',summary:'Build a habit coach with accessible controls, honest asynchronous persistence, completion history and recoverable loading states.',concepts:['React','accessibility','async state','persistence','testing'],
 explanation:'The interface should distinguish saved state, an unsaved draft and an in-flight change. Publish a new habit list only after persistence acknowledges it. Fence old promises after a changed data source or unmount, and use native labeled controls plus polite status updates. This exercise uses a local adapter, not health advice or cross-device synchronization.',
 instructions:[
  'Implement App in src/App.jsx. Props are load(signal), save(habits,signal), today (YYYY-MM-DD), and makeId(). The supplied defaults use versioned localStorage. Call validateHabits from storage.js on loaded data and edits: at most 100 habits, unique IDs and case-insensitive trimmed labels, and unique valid date strings. Do not mutate supplied arrays.',
  'While loading show role="status" with "Loading habits…". On failure show role="alert" with "Could not load habits" and button "Retry loading"; do not show editing controls or silently replace corrupt data. On success show a "Habit name" input, "Add habit" button, and "No habits yet" when empty.',
  'New habits are {id:makeId(),label:trimmedInput,days:[]}. Use list items with literal labels and native buttons named "Delete LABEL" and either "Mark LABEL today" or "Unmark LABEL today". Toggle only today, preserving historical days. Show one status "N habits · M completed today" when ready.',
  'Call save(nextHabits,signal) once per valid mutation. Disable editing while pending and publish only after success; clear the add draft only after a successful add. Failed saves show "Change not saved. Try again.", retain prior saved state and the draft, and permit an explicit retry of the action. No automatic retry.',
  'Abort in-flight loads/saves on unmount or a changed load prop and ignore late results even if an adapter ignores cancellation. Keep default functions stable, derive completion counts from habits, and retain labeled keyboard-accessible controls. A changed load prop represents a new data source.',
 ],milestones:milestones([
  {title:'Load and recover',goal:'Distinguish pending, empty, valid and failed restored state without losing data.',acceptance:['Loading and errors are announced accessibly.','Invalid saved rows require an explicit recovery action.']},
  {title:'Edit habits accessibly',goal:'Add and remove validated habits through labeled native controls.',acceptance:['Normalize labels and reject duplicates.','Treat labels as text, never executable markup.']},
  {title:'Track daily completion',goal:'Toggle today without losing historical dates or mutating input state.',acceptance:['Completion counts reflect the saved habit list.','Toggling twice restores the earlier dates.']},
  {title:'Protect asynchronous state',goal:'Keep unacknowledged edits and obsolete operations from becoming saved UI state.',acceptance:['Failed saves retain the draft and prior list.','Changing sources or unmounting cancels and fences old work.']},
 ],stage=>({executable:'npm',args:['test','--','--run','-t',stage]})),hints:['Keep saved habits, draft, loading/error and saving status separate.','An AbortController asks an adapter to stop; an identity or cleanup guard also prevents ignored aborts from updating state.','Use a ref to reject a second mutation before the disabled render commits.'],reflectionQuestions:['Why does a failed save leave the old list visible even though the new list was computed?','How do stable default functions and cleanup guards prevent loops and stale results?'],examples:[{input:'Read marked yesterday; mark today then unmark today',output:'Yesterday remains, today is removed'},{input:'Storage rejects Add habit',output:'Prior list and typed draft remain; an alert explains the failed save'}],files:[...reactLessonFiles(habitSource,checks).map(file=>file.path==='index.html'?{...file,content:file.content.replace('CodeTutor practice','Accessible habit coach')}:file),{path:'src/storage.js',content:habitStorage}],command:{executable:'npm',args:['test','--','--run']},preparation:'Run npm install, then npm test -- --run. Run npm run dev for port 3000 preview and npm run build to check the browser bundle. Dependencies must be installed again after source-only restoration.',
})
