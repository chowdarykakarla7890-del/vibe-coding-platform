import { nodeFiles, practiceLesson } from './shared'

const command = { executable: 'node', args: ['--test', 'lesson.test.mjs'] }
const preparation = 'Node 24 runs these erasable TypeScript annotations without type-checking. Run npm install, then npm run typecheck for the separate strict compiler check; npm test runs behavior checks.'
export const typescriptPractice = [
  practiceLesson({ track: 'typescript', stage: 'fundamentals', title: 'Route a support ticket',
    summary: 'Use literal unions and exhaustive branching to model a support queue without magic strings.',
    concepts: ['union types', 'exhaustiveness', 'functions'],
    explanation: 'Literal unions limit values at compile time. A routing function can then explicitly handle each allowed combination. Runtime tests exercise behavior, while the strict compiler catches missing return paths and invalid values at call sites; neither check replaces the other.',
    instructions: ['Implement routeTicket(priority, paid) returning a Queue. Critical tickets always go to "urgent"; normal paid tickets go to "priority"; normal unpaid and all low-priority tickets go to "standard".', 'Keep the exported Priority and Queue unions and the typed function signature. Inputs satisfy those types. Do not widen the function to any or return an untyped string.'],
    hints: ['Handle critical priority before checking paid status.', 'A low-priority paid ticket still belongs in the standard queue.', 'Make every branch return one of the Queue literals.'],
    reflectionQuestions: ['What can a union prevent at compile time that a runtime test cannot?', 'Would TypeScript validate an untrusted JSON priority without a runtime check? Explain.'],
    examples: [{ input: 'routeTicket("critical", false)', output: '"urgent"' }, { input: 'routeTicket("low", true)', output: '"standard"' }],
    files: nodeFiles(`export type Priority = 'critical' | 'normal' | 'low'\nexport type Queue = 'urgent' | 'priority' | 'standard'\n\nexport function routeTicket(priority: Priority, paid: boolean): Queue {\n  // TODO: route every allowed combination.\n  throw new Error('Complete the TODO before submitting')\n}\n`, 'routeTicket', [
      ['critical ignores account tier', 'assert.equal(routeTicket("critical", false), "urgent")\nassert.equal(routeTicket("critical", true), "urgent")'],
      ['normal uses account tier', 'assert.equal(routeTicket("normal", true), "priority")\nassert.equal(routeTicket("normal", false), "standard")'],
      ['low remains standard', 'assert.equal(routeTicket("low", true), "standard")\nassert.equal(routeTicket("low", false), "standard")'],
    ], true), command, preparation, quality: 'Preserves narrow types and covers every valid priority without any casts',
  }),
  practiceLesson({ track: 'typescript', stage: 'data-flow', title: 'Summarize payments by currency',
    summary: 'Aggregate paid invoices into typed currency totals while keeping distinct monetary units separate.',
    concepts: ['readonly types', 'records', 'aggregation'],
    explanation: 'Money in different currencies cannot be added into a meaningful single total without a conversion rule. A Record gives a fixed set of currency keys; readonly inputs describe the boundary between source invoices and their derived summary.',
    instructions: ['Implement paidTotals(invoices) returning a Record<Currency, number> with USD, EUR and INR keys always present. Include only invoices whose status is "paid"; use amountCents directly, with no currency conversion.', 'Amounts are nonnegative integers and sums fit in a safe integer. Empty input returns three zeros. Do not mutate invoices or their elements; retain readonly input types and exported types.'],
    hints: ['Initialize all currency keys even if no invoice uses them.', 'Narrow by status before adding to the currency bucket.', 'Keep the accumulator typed as Record<Currency, number>.'],
    reflectionQuestions: ['Why is a single number not a correct total for this dataset?', 'Does readonly freeze an object at runtime? What did the test freeze?'],
    examples: [{ input: '[{currency:"INR",amountCents:1500,status:"paid"}]', output: '{USD:0,EUR:0,INR:1500}' }],
    files: nodeFiles(`export type Currency = 'USD' | 'EUR' | 'INR'\nexport type Invoice = Readonly<{currency: Currency; amountCents: number; status: 'paid' | 'pending' | 'void'}>\n\nexport function paidTotals(invoices: readonly Invoice[]): Record<Currency, number> {\n  // TODO: summarize paid invoices without changing them.\n  throw new Error('Complete the TODO before submitting')\n}\n`, 'paidTotals', [
      ['empty total has every key', 'assert.deepEqual(paidTotals([]),{USD:0,EUR:0,INR:0})'],
      ['separates currencies and excludes unpaid', 'assert.deepEqual(paidTotals([{currency:"USD",amountCents:120,status:"paid"},{currency:"USD",amountCents:30,status:"paid"},{currency:"EUR",amountCents:90,status:"paid"},{currency:"INR",amountCents:500,status:"pending"},{currency:"USD",amountCents:999,status:"void"}]),{USD:150,EUR:90,INR:0})'],
      ['readonly source', 'const input=Object.freeze([Object.freeze({currency:"INR",amountCents:1500,status:"paid"})])\nassert.deepEqual(paidTotals(input),{USD:0,EUR:0,INR:1500})\nassert.equal(input[0].amountCents,1500)'],
    ], true), command, preparation, quality: 'Uses readonly inputs and typed currency keys without mixing monetary units',
  }),
  practiceLesson({ track: 'typescript', stage: 'composition', title: 'Validate a signup payload',
    summary: 'Turn unknown input into a discriminated success or failure result with deterministic validation order.',
    concepts: ['unknown', 'type narrowing', 'discriminated unions'],
    explanation: 'Type annotations do not make incoming JSON safe. Start with unknown, narrow the object, and validate fields before returning a trusted value. A discriminated result lets callers branch on ok instead of assuming a value exists or catching expected validation exceptions.',
    instructions: ['Implement parseSignup(input: unknown): SignupResult. Reject null, arrays and nonobjects with {ok:false,error:"object"}. Then validate name: a string whose trimmed length is 2–40 inclusive, otherwise error:"name".', 'Then validate age: an integer number from 13 to 120 inclusive, otherwise error:"age". Success is exactly {ok:true,value:{name:trimmedName,age}}. Ignore extra fields, do not mutate input, and never throw for invalid data.', 'Keep the exported discriminated union; use narrowing rather than any. Validation order is object, name, age when several fields are invalid.'],
    hints: ['typeof null is "object", so check it separately.', 'Narrow each field before using string or number operations.', 'Build a fresh success value rather than returning the original object.'],
    reflectionQuestions: ['Why must the function accept unknown rather than Signup?', 'How does the ok discriminator simplify callers and prevent missing-value errors?'],
    examples: [{ input: 'parseSignup({name:" Ada ",age:13,admin:true})', output: '{ok:true,value:{name:"Ada",age:13}}' }, { input: 'parseSignup({name:" ",age:12})', output: '{ok:false,error:"name"}' }],
    files: nodeFiles(`export type Signup = { name: string; age: number }\nexport type SignupResult = { ok: true; value: Signup } | { ok: false; error: 'object' | 'name' | 'age' }\n\nexport function parseSignup(input: unknown): SignupResult {\n  // TODO: narrow unknown and return a validated result.\n  throw new Error('Complete the TODO before submitting')\n}\n`, 'parseSignup', [
      ['rejects nonobjects', 'for (const value of [null,undefined,[],true,12,"Ada"]) assert.deepEqual(parseSignup(value),{ok:false,error:"object"})'],
      ['checks name before age', 'for (const name of [undefined,12," ","A","a".repeat(41)]) assert.deepEqual(parseSignup({name,age:12}),{ok:false,error:"name"})'],
      ['age boundaries and number domain', 'for (const age of [undefined,"13",12,121,13.5,NaN,Infinity]) assert.deepEqual(parseSignup({name:"Ada",age}),{ok:false,error:"age"})\nfor (const age of [13,120]) assert.deepEqual(parseSignup({name:"Ada",age}),{ok:true,value:{name:"Ada",age}})'],
      ['trims, strips extras and does not mutate', 'const input=Object.freeze({name:" Ada ",age:20,admin:true})\nassert.deepEqual(parseSignup(input),{ok:true,value:{name:"Ada",age:20}})\nassert.equal(input.name," Ada ")'],
    ], true), command, preparation, quality: 'Narrows unknown safely and uses a discriminated result instead of throwing expected errors',
  }),
]
