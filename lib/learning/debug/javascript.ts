import { debugLesson, nodeFiles } from '../practice/shared'

const command = { executable: 'node', args: ['--test', 'lesson.test.mjs'] }
export const javascriptDebug = [
  debugLesson({ track: 'javascript', stage: 'state-bug', title: 'Stop a reservation from changing old stock',
    summary: 'A reservation returns the right quantity, but an earlier stock view changes too. Trace the aliasing bug.',
    concepts: ['debugging', 'object identity', 'immutability'],
    explanation: 'Copying an array does not copy the objects it contains. A result can appear correct while silently changing an older view through shared references. Check both the returned value and the previous state when investigating mutation bugs.',
    instructions: ['Repair reserve(stock, id, units) in src/main.mjs. Stock is an array of unique {id,quantity} objects with nonnegative integer quantities; units is a positive integer. A valid reservation returns a new array with only the matching object copied and its quantity reduced.', 'Missing IDs or insufficient stock return the exact original array. Never modify the old array or its objects; unchanged objects retain their references. Do not change the function signature or remove checks.'],
    hints: ['Compare stock[0] before and after a successful reservation.', 'Does [...stock] create new objects or only a new array?', 'Copy the object that changes before assigning its new quantity.'],
    reflectionQuestions: ['Why did checking only the returned quantity miss this bug?', 'How could this alias affect undo history or a second React view?'],
    examples: [{ input: 'reserve([{id:"pen",quantity:5}], "pen", 2)', output: 'New stock contains quantity 3; original stock still contains 5' }],
    files: nodeFiles(`export function reserve(stock, id, units) {\n  const index = stock.findIndex(item => item.id === id)\n  if (index < 0 || stock[index].quantity < units) return stock\n  const next = [...stock]\n  next[index].quantity -= units\n  return next\n}\n`, 'reserve', [
      ['successful reservation returns the reduced quantity', 'assert.deepEqual(reserve([{id:"pen",quantity:5}],"pen",2),[{id:"pen",quantity:3}])'],
      ['old stock must remain unchanged', 'const first={id:"pen",quantity:5}, second={id:"book",quantity:2}, old=[first,second]\nconst next=reserve(old,"pen",2)\nassert.equal(first.quantity,5,"reservation mutated the previous stock object")\nassert.notEqual(next,old)\nassert.notEqual(next[0],first)\nassert.equal(next[1],second)'],
      ['no-op identity and exact depletion', 'const old=[{id:"pen",quantity:5}]\nassert.equal(reserve(old,"missing",1),old)\nassert.equal(reserve(old,"pen",6),old)\nassert.deepEqual(reserve(old,"pen",5),[{id:"pen",quantity:0}])'],
    ]), command, quality: 'Repairs the shared-object mutation while retaining no-op and unchanged-object identity',
  }),
  debugLesson({ track: 'javascript', stage: 'edge-cases', title: 'Find the missing pagination item',
    summary: 'Page boundaries silently drop records. Reproduce the loss and repair the interval calculation.',
    concepts: ['debugging', 'array slicing', 'boundary cases'],
    explanation: 'Array.slice uses an inclusive start and an exclusive end. Mixing inclusive-page arithmetic with an exclusive slice can lose an item on every page, especially when a page size is one.',
    instructions: ['Repair pageItems(items, page, size). Page numbers start at 1; page and size must be positive safe integers or throw RangeError. Return up to size items in order, without mutation. Out-of-range pages return [].', 'For valid inputs, (page - 1) * size and page * size fit safe integers. Preserve the existing validation. Cover full pages, partial final pages, size 1 and empty arrays.'],
    hints: ['Write the intended start and exclusive end for page 1 with size 2.', 'Check how slice treats its second argument.', 'Concatenate successive pages and compare them with the original input.'],
    reflectionQuestions: ['Why does page size 1 expose this error immediately?', 'What invariant should hold when concatenating all pages of a fixed list?'],
    examples: [{ input: 'pageItems(["a","b","c"], 1, 2)', output: '["a","b"]' }, { input: 'pageItems(["a","b","c"], 2, 2)', output: '["c"]' }],
    files: nodeFiles(`export function pageItems(items, page, size) {\n  if (!Number.isSafeInteger(page) || !Number.isSafeInteger(size) || page < 1 || size < 1) throw new RangeError('Positive page and size required')\n  const start = (page - 1) * size\n  return items.slice(start, start + size - 1)\n}\n`, 'pageItems', [
      ['empty and out-of-range pages stay empty', 'assert.deepEqual(pageItems([],1,2),[])\nassert.deepEqual(pageItems([1],3,2),[])'],
      ['full and partial pages do not lose records', 'assert.deepEqual(pageItems([1,2,3,4,5],1,2),[1,2],"first page loses its last item")\nassert.deepEqual(pageItems([1,2,3,4,5],3,2),[5])\nassert.deepEqual(pageItems([9],1,1),[9])'],
      ['all pages reproduce the immutable source', 'const old=Object.freeze([1,2,3,4,5])\nassert.deepEqual([1,2,3].flatMap(page=>pageItems(old,page,2)),old)'],
      ['invalid pagination is rejected', 'for(const [page,size] of [[0,2],[1,0],[1.5,2],[1,Infinity],[-1,2]])assert.throws(()=>pageItems([],page,size),RangeError)'],
    ]), command, quality: 'Repairs the exclusive-end calculation without weakening pagination validation',
  }),
]
