// Test-only reference implementations. Never include these in a learner's catalog.
import { plannerSource } from '@/lib/learning/blueprints/python'
import { lendingSource } from '@/lib/learning/blueprints/java'
import { boardSource } from '@/lib/learning/blueprints/typescript'

const finance=String.raw`
function record(value){
 if(!value||typeof value.id!=='string'||!value.id||value.id.length>40||typeof value.label!=='string'||typeof value.category!=='string')throw Error('Invalid entry')
 const label=value.label.trim(),category=value.category.trim(),amount=value.amount
 if(!label||label.length>80||!category||category.length>30||!Number.isInteger(amount)||amount===0||Math.abs(amount)>100000000)throw Error('Invalid entry')
 return {id:value.id,label,amount,category}
}
function validate(rows){if(!Array.isArray(rows)||rows.length>1000)throw Error('Invalid ledger');const values=rows.map(record);if(new Set(values.map(x=>x.id)).size!==values.length)throw Error('Duplicate');return values}
export function addEntry(rows,input){const next=validate([...rows,record(input)]);return next}
export function removeEntry(rows,id){return rows.filter(x=>x.id!==id)}
export function selectEntries(rows,{query='',category=''}={}){query=query.trim().toLowerCase();category=category.trim();return rows.filter(x=>x.label.toLowerCase().includes(query)&&(!category||x.category===category))}
export function totals(rows){const income=rows.reduce((a,x)=>a+Math.max(0,x.amount),0),expense=rows.reduce((a,x)=>a-Math.min(0,x.amount),0);return {income,expense,balance:income-expense}}
export function decodeLedger(raw){if(raw===null)return [];const value=JSON.parse(raw);if(!value||value.version!==1)throw Error('Version');return validate(value.entries)}
export function encodeLedger(rows){return JSON.stringify({version:1,entries:validate(rows)})}
`
const board=boardSource.slice(0,boardSource.indexOf('export function'))+String.raw`
const priorities:Priority[]=['high','normal','low'],statuses:Status[]=['todo','doing','done']
function record(value:unknown):Issue {
 if(!value||typeof value!=='object')throw Error('Invalid issue')
 const row=value as Record<string,unknown>
 if(typeof row.id!=='string'||!/^[a-zA-Z0-9_-]{1,40}$/.test(row.id)||typeof row.title!=='string'||!priorities.includes(row.priority as Priority)||!statuses.includes(row.status as Status))throw Error('Invalid issue')
 const title=row.title.trim();if(title.length<3||title.length>80)throw Error('Invalid title')
 return {id:row.id,title,priority:row.priority as Priority,status:row.status as Status}
}
function validate(input:unknown):Issue[]{if(!Array.isArray(input)||input.length>500)throw Error('Invalid board');const rows=input.map(record);if(new Set(rows.map(x=>x.id)).size!==rows.length)throw Error('Duplicate');return rows}
export function createIssue(board:readonly Issue[],input:NewIssue):Issue[]{return validate([...board,{...input,status:'todo'}])}
export function moveIssue(board:readonly Issue[],id:string,target:Status):Issue[]{
 const old=board.find(x=>x.id===id);if(!old||!statuses.includes(target))throw Error('Invalid transition')
 const allowed:Record<Status,Status[]>={todo:['doing'],doing:['todo','done'],done:['doing']}
 if(old.status!==target&&!allowed[old.status].includes(target))throw Error('Forbidden transition')
 return board.map(x=>x.id===id?{...x,status:target}:x)
}
export function viewIssues(board:readonly Issue[],filters:{query?:string;status?:Status|'all'}={}):{issues:Issue[];counts:Record<Status,number>}{
 const counts:Record<Status,number>={todo:0,doing:0,done:0};for(const x of board)counts[x.status]++
 const query=(filters.query??'').trim().toLowerCase(),status=filters.status??'all'
 const issues=board.filter(x=>x.title.toLowerCase().includes(query)&&(status==='all'||x.status===status)).sort((a,b)=>priorities.indexOf(a.priority)-priorities.indexOf(b.priority)||(a.id<b.id?-1:a.id>b.id?1:0))
 return {issues,counts}
}
export function parseBoard(raw:string|null):Issue[]{if(raw===null)return [];const value=JSON.parse(raw);if(!value||value.version!==1)throw Error('Version');return validate(value.issues)}
`
const planner=String.raw`import argparse,json,os,sys,tempfile,re
from pathlib import Path
from datetime import date
def record(task):
    if not isinstance(task,dict):raise ValueError('Task')
    if not isinstance(task.get('id'),str) or re.fullmatch(r'[a-zA-Z0-9_-]{1,40}',task['id']) is None:raise ValueError('ID')
    title=task.get('title');minutes=task.get('minutes');priority=task.get('priority');due=task.get('due')
    if not isinstance(title,str) or not 1<=len(title.strip())<=80:raise ValueError('Title')
    if type(minutes) is not int or not 1<=minutes<=480 or type(priority) is not int or not 1<=priority<=3 or type(task.get('done')) is not bool:raise ValueError('Task')
    if not isinstance(due,str) or re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}',due) is None or date.fromisoformat(due).isoformat()!=due:raise ValueError('Date')
    return {'id':task['id'],'title':title.strip(),'minutes':minutes,'priority':priority,'due':due,'done':task['done']}
def validate(tasks):
    if not isinstance(tasks,list) or len(tasks)>500:raise ValueError('Tasks')
    rows=[record(task) for task in tasks]
    if len({task['id'] for task in rows})!=len(rows):raise ValueError('Duplicate')
    return rows
def add_task(tasks,task):
    entry=record(task)
    if entry['done']:raise ValueError('New task must be pending')
    return validate([*tasks,entry])
def complete_task(tasks,task_id):
    rows=validate(tasks)
    if not any(task['id']==task_id for task in rows):raise ValueError('Unknown task')
    return [{**task,'done':True} if task['id']==task_id else task for task in rows]
def schedule(tasks,minutes):
    if type(minutes) is not int or not 0<=minutes<=1440:raise ValueError('Budget')
    chosen=[]
    for task in sorted(validate(tasks),key=lambda row:(row['due'],row['priority'],row['id'])):
        if not task['done'] and task['minutes']<=minutes:chosen.append(task['id']);minutes-=task['minutes']
    return chosen
def decode(raw):
    if raw is None:return []
    value=json.loads(raw)
    if not isinstance(value,dict) or type(value.get('version')) is not int or value['version']!=1:raise ValueError('Version')
    return validate(value.get('tasks'))

`+plannerSource.slice(plannerSource.indexOf('def load(path):'))

const library=lendingSource.replace('    public void addBook',String.raw`    private static String id(String value){if(value==null||!value.matches("[a-zA-Z0-9_-]{1,40}"))throw new IllegalArgumentException();return value;}
    private static String label(String value){if(value==null||value.strip().isEmpty()||value.strip().length()>80)throw new IllegalArgumentException();return value.strip();}
    private static void day(int value){if(value<0||value>1000000)throw new IllegalArgumentException();}
    public void addBook`).replace('throw new UnsupportedOperationException("Complete the TODO: register books");',String.raw`id(id);String text=label(title);if(books.containsKey(id))throw new IllegalArgumentException();books.put(id,new Book(id,text));`)
 .replace('throw new UnsupportedOperationException("Complete the TODO: register members");',String.raw`id(id);String text=label(name);if(members.containsKey(id))throw new IllegalArgumentException();members.put(id,text);`)
 .replace('throw new UnsupportedOperationException("Complete the TODO: enforce lending rules");',String.raw`id(bookId);id(memberId);day(day);if(!books.containsKey(bookId)||!members.containsKey(memberId))throw new IllegalArgumentException();if(loans.containsKey(bookId)||loansFor(memberId).size()>=3)throw new IllegalStateException();Loan loan=new Loan(bookId,memberId,day+14);loans.put(bookId,loan);return loan;`)
 .replace('throw new UnsupportedOperationException("Complete the TODO: return a borrowed book");',String.raw`id(bookId);if(!books.containsKey(bookId))throw new IllegalArgumentException();if(!loans.containsKey(bookId))throw new IllegalStateException();return loans.remove(bookId);`)
 .replace('throw new UnsupportedOperationException("Complete the TODO: report overdue loans");',String.raw`day(day);return loans.values().stream().filter(loan->loan.dueDay()<day).sorted(Comparator.comparing(Loan::bookId)).toList();`)
 .replace('throw new UnsupportedOperationException("Complete the TODO: return an immutable member report");',String.raw`id(memberId);if(!members.containsKey(memberId))throw new IllegalArgumentException();return loans.values().stream().filter(loan->loan.memberId().equals(memberId)).sorted(Comparator.comparing(Loan::bookId)).toList();`)

const tasks=String.raw`#pragma once
#include <algorithm>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>
#include <set>
struct Task { int id; int priority; bool done; std::string title; };
inline Task record(Task task){
 if(task.id<1||task.id>1000000||task.priority<1||task.priority>3)throw std::invalid_argument("Task");
 for(unsigned char c:task.title)if(c<32||c>126)throw std::invalid_argument("Title");
 const auto first=task.title.find_first_not_of(' '),last=task.title.find_last_not_of(' ');
 task.title=first==std::string::npos?"":task.title.substr(first,last-first+1);
 if(task.title.empty()||task.title.size()>80)throw std::invalid_argument("Title");return task;
}
inline std::vector<Task> validate(const std::vector<Task>& tasks){
 if(tasks.size()>1000)throw std::invalid_argument("Count");std::set<int> ids;std::vector<Task> result;
 for(auto task:tasks){task=record(task);if(!ids.insert(task.id).second)throw std::invalid_argument("Duplicate");result.push_back(task);}return result;
}
inline std::vector<Task> addTask(const std::vector<Task>& tasks,Task input){if(input.done)throw std::invalid_argument("Pending required");auto next=tasks;next.push_back(input);return validate(next);}
inline std::vector<Task> finishTask(const std::vector<Task>& tasks,int id){auto next=validate(tasks);bool found=false;for(auto& task:next)if(task.id==id){task.done=true;found=true;}if(!found)throw std::invalid_argument("Unknown");return next;}
inline std::optional<Task> nextTask(const std::vector<Task>& tasks){std::optional<Task> next;for(const auto& task:tasks)if(!task.done&&(!next||task.priority<next->priority||(task.priority==next->priority&&task.id<next->id)))next=task;return next;}
inline std::string encode(const std::vector<Task>& tasks){std::ostringstream out;out<<"CODETUTOR_TASKS_V1\n";for(const auto& task:validate(tasks))out<<task.id<<'\t'<<task.priority<<'\t'<<(task.done?1:0)<<'\t'<<task.title<<'\n';return out.str();}
inline int integer(const std::string& field){if(field.empty()||field.size()>7||field[0]=='0')throw std::invalid_argument("Number");int value=0;for(char c:field){if(c<'0'||c>'9')throw std::invalid_argument("Number");value=value*10+c-'0';}return value;}
inline std::vector<Task> decode(const std::string& text){
 const std::string header="CODETUTOR_TASKS_V1\n";if(text.rfind(header,0)!=0)throw std::invalid_argument("Header");
 std::istringstream input(text.substr(header.size()));std::string line;std::vector<Task> result;
 while(std::getline(input,line)){
  const auto a=line.find('\t'),b=a==std::string::npos?a:line.find('\t',a+1),c=b==std::string::npos?b:line.find('\t',b+1);
  if(c==std::string::npos||line.find('\t',c+1)!=std::string::npos)throw std::invalid_argument("Fields");
  const auto done=line.substr(b+1,c-b-1);if(done!="0"&&done!="1")throw std::invalid_argument("Done");
  result.push_back({integer(line.substr(0,a)),integer(line.substr(a+1,b-a-1)),done=="1",line.substr(c+1)});
 }return validate(result);
}
`
const habits=String.raw`import React,{useEffect,useRef,useState} from 'react'
import {loadHabits,saveHabits,validateHabits} from './storage.js'
const newId=()=>crypto.randomUUID()
export default function App({load=loadHabits,save=saveHabits,today=new Date().toISOString().slice(0,10),makeId=newId}){
 const [state,setState]=useState({phase:'loading',habits:[]}),[draft,setDraft]=useState(''),[error,setError]=useState(''),[saving,setSaving]=useState(false),[retry,setRetry]=useState(0)
 const scope=useRef(null),mutation=useRef(null)
 useEffect(()=>{
  const task=new AbortController();scope.current=task;mutation.current?.abort();mutation.current=null
  setState({phase:'loading',habits:[]});setDraft('');setError('');setSaving(false)
  Promise.resolve().then(()=>load(task.signal)).then(validateHabits).then(habits=>{if(!task.signal.aborted)setState({phase:'ready',habits})},()=>{if(!task.signal.aborted)setState({phase:'error',habits:[]})})
  return ()=>{task.abort();mutation.current?.abort();mutation.current=null}
 },[load,retry])
 async function change(next,clear=false){
  if(mutation.current||state.phase!=='ready')return
  let rows;try{rows=validateHabits(next)}catch{setError('Invalid habit. Check the name and duplicates.');return}
  const task=new AbortController(),origin=scope.current;mutation.current=task;setSaving(true);setError('')
  try{
   await save(rows,task.signal)
   if(task.signal.aborted||scope.current!==origin)return
   setState({phase:'ready',habits:rows});if(clear)setDraft('')
  }catch{if(!task.signal.aborted&&scope.current===origin)setError('Change not saved. Try again.')}
  finally{if(mutation.current===task){mutation.current=null;setSaving(false)}}
 }
 if(state.phase==='loading')return <main><h1>Habit coach</h1><p role="status">Loading habits…</p></main>
 if(state.phase==='error')return <main><h1>Habit coach</h1><p role="alert">Could not load habits</p><button onClick={()=>setRetry(x=>x+1)}>Retry loading</button></main>
 const rows=state.habits
 return <main><h1>Habit coach</h1>{error?<p role="alert">{error}</p>:null}
  <form onSubmit={event=>{event.preventDefault();void change([...rows,{id:makeId(),label:draft,days:[]}],true)}}>
   <label>Habit name<input value={draft} disabled={saving} onChange={event=>setDraft(event.target.value)}/></label><button disabled={saving}>Add habit</button>
  </form>
  <p role="status">{rows.length} habits · {rows.filter(row=>row.days.includes(today)).length} completed today</p>
  {!rows.length?<p>No habits yet</p>:null}<ul>{rows.map(row=><li key={row.id}>{row.label}
   <button disabled={saving} onClick={()=>void change(rows.map(x=>x.id===row.id?{...x,days:x.days.includes(today)?x.days.filter(day=>day!==today):[...x.days,today]}:x))}>{row.days.includes(today)?'Unmark':'Mark'} {row.label} today</button>
   <button disabled={saving} onClick={()=>void change(rows.filter(x=>x.id!==row.id))}>Delete {row.label}</button>
  </li>)}</ul>
 </main>
}
`

export const projectSolutions:Record<string,{path:string;content:string}[]>={
 'project-javascript-blueprint':[{path:'src/ledger.mjs',content:finance}],
 'project-typescript-blueprint':[{path:'src/board.ts',content:board}],
 'project-react-blueprint':[{path:'src/App.jsx',content:habits}],
 'project-python-blueprint':[{path:'src/main.py',content:planner}],
 'project-java-blueprint':[{path:'Main.java',content:library}],
 'project-cpp-blueprint':[{path:'src/tasks.hpp',content:tasks}],
}
