import { debugLesson, nodeFiles } from '../practice/shared'

const command = { executable: 'node', args: ['--test', 'lesson.test.mjs'] }
const preparation = 'Node 24 executes the TypeScript without checking its types. Run npm install and npm run typecheck separately; npm test runs the behavior checks.'
export const typescriptDebug = [
  debugLesson({ track: 'typescript', stage: 'state-bug', title: 'Repair a job that never starts',
    summary: 'A job’s finish transition works, but start silently returns the old state. Trace branch ownership.',
    concepts: ['debugging', 'control flow', 'typed state'],
    explanation: 'An else belongs to its nearest unmatched if. Two adjacent conditionals can unintentionally undo or bypass a successful transition. A type-correct implementation can still violate its state-machine contract.',
    instructions: ['Repair transition(job, event). Job has {id:string,status:"idle"|"running"|"complete"}; event is "start" or "finish". idle + start returns a new running job; running + finish returns a new complete job.', 'All other combinations return the exact original object. Retain the ID, do not mutate input, and preserve the exported types and signature.'],
    hints: ['Trace idle/start through every if, not just the first matching one.', 'Which if owns the final else?', 'Make the allowed transitions mutually exclusive.'],
    reflectionQuestions: ['Why did a successful assignment not become the returned result?', 'Why would TypeScript alone not catch this behavioral bug?'],
    examples: [{ input: 'transition({id:"a",status:"idle"}, "start")', output: '{id:"a",status:"running"}' }],
    files: nodeFiles(`export type Job = Readonly<{id: string; status: 'idle' | 'running' | 'complete'}>\nexport type Event = 'start' | 'finish'\nexport function transition(job: Job, event: Event): Job {\n  const next = { ...job }\n  if (job.status === 'idle' && event === 'start') next.status = 'running'\n  if (job.status === 'running' && event === 'finish') next.status = 'complete'\n  else return job\n  return next\n}\n`, 'transition', [
      ['running jobs finish', 'assert.deepEqual(transition({id:"a",status:"running"},"finish"),{id:"a",status:"complete"})'],
      ['idle jobs start without mutating their old state', 'const old=Object.freeze({id:"a",status:"idle"})\nconst next=transition(old,"start")\nassert.deepEqual(next,{id:"a",status:"running"},"start transition was discarded")\nassert.notEqual(next,old)\nassert.equal(old.status,"idle")'],
      ['unsupported transitions retain object identity', 'for(const [status,event]of [["idle","finish"],["running","start"],["complete","start"],["complete","finish"]]){const old={id:"a",status};assert.equal(transition(old,event),old)}'],
    ], true), command, preparation, quality: 'Repairs conditional branching while preserving typed states and no-op identity',
  }),
  debugLesson({ track: 'typescript', stage: 'edge-cases', title: 'Reject partially numeric limits',
    summary: 'A page-size parser accepts malformed values such as 12px. Tighten validation without breaking defaults.',
    concepts: ['debugging', 'parsing', 'input validation'],
    explanation: 'Parsing a numeric prefix is different from validating an entire string. A parser that stops at the first invalid character may silently accept typos or an unintended unit. The accepted input grammar should be explicit before numeric conversion.',
    instructions: ['Repair parseLimit(raw, fallback). raw is string or undefined; fallback is a valid integer from 1 to 100. Undefined or whitespace-only raw returns fallback. Otherwise trim and accept only ASCII digits representing an integer 1–100 inclusive; leading zeros are allowed.', 'Throw RangeError for signs, decimals, suffixes, exponent notation, non-ASCII digits and out-of-range values. Keep the TypeScript signature; do not use any or change callers.'],
    hints: ['What does parseInt("12px", 10) return?', 'Check the whole trimmed string against the accepted grammar.', 'Keep empty-input defaulting separate from numeric validation.'],
    reflectionQuestions: ['When is prefix parsing useful, and why is it wrong here?', 'Which tests distinguish lexical validation from range validation?'],
    examples: [{ input: 'parseLimit(" 020 ", 10)', output: '20' }, { input: 'parseLimit("12px", 10)', output: 'RangeError' }],
    files: nodeFiles(`export function parseLimit(raw: string | undefined, fallback: number): number {\n  if (raw === undefined || raw.trim() === '') return fallback\n  const value = Number.parseInt(raw.trim(), 10)\n  if (!Number.isInteger(value) || value < 1 || value > 100) throw new RangeError('Invalid limit')\n  return value\n}\n`, 'parseLimit', [
      ['valid limits and defaults', 'assert.equal(parseLimit(undefined,10),10)\nassert.equal(parseLimit(" ",20),20)\nfor(const [raw,value]of [["1",1],["100",100],[" 020 ",20]])assert.equal(parseLimit(raw,10),value)'],
      ['whole-string grammar is enforced', 'for(const value of ["12px","1.9","+7","1e2","２０","-5"])assert.throws(()=>parseLimit(value,10),RangeError,`accepted malformed limit ${value}`)'],
      ['range errors remain errors', 'for(const value of ["0","101","999999999999999999999"])assert.throws(()=>parseLimit(value,10),RangeError)'],
    ], true), command, preparation, quality: 'Validates the complete string before conversion and preserves default/range behavior',
  }),
]
