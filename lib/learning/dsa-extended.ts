import type { ActivityManifest, Difficulty } from './types'
import { DSA_LANGUAGES, dsaEntryPath, type DSALanguage } from './dsa-foundations'

export type DSAFieldType = 'integer' | 'text' | 'integers' | 'nullableIntegers' | 'matrix' | 'strings'
export type DSAResultType = 'integer' | 'boolean' | 'integers' | 'matrix' | 'numbers'
export type DSAInputValue = number | string | number[] | (number | null)[] | number[][] | string[]
export type ExtendedDSAInput = Record<string, DSAInputValue>
interface Specification {
  title: string
  summary: string
  difficulty: Difficulty
  concepts: string[]
  fields: { name: string; type: DSAFieldType }[]
  result: DSAResultType
  contract: string
  constraints: string
  hint: string
  examples: { input: ExtendedDSAInput; output: unknown }[]
}

export const extendedSpecifications = {
  'dsa-python-merge-intervals': {
    title: 'Merge Intervals', summary: 'Combine overlapping closed intervals into a sorted, non-overlapping union.', difficulty: 'intermediate', concepts: ['sorting', 'intervals'],
    fields: [{ name: 'intervals', type: 'matrix' }], result: 'matrix',
    contract: 'Return merged closed intervals ordered by start. Touching endpoints overlap: [1,3] and [3,5] become [1,5]. Do not merge separated intervals. Input order is arbitrary; duplicates and zero-length intervals are valid.',
    constraints: 'intervals contains 0–20 pairs [start,end], with integer -1000 <= start <= end <= 1000.',
    hint: 'Sort by start, then maintain the union of the intervals already visited. Explain when a new interval can safely be emitted.',
    examples: [{ input: { intervals: [[8,10],[1,3],[2,6]] }, output: [[1,6],[8,10]] }, { input: { intervals: [[1,3],[3,5]] }, output: [[1,5]] }, { input: { intervals: [] }, output: [] }],
  },
  'dsa-python-longest-substring': {
    title: 'Longest Unique Substring', summary: 'Find the length of the longest contiguous substring without repeated characters.', difficulty: 'intermediate', concepts: ['sliding window', 'hash maps'],
    fields: [{ name: 'text', type: 'text' }], result: 'integer',
    contract: 'Return the maximum length of a contiguous substring with no repeated characters. A substring cannot skip characters. Return 0 for an empty string.',
    constraints: 'text contains 0–200 lowercase ASCII letters a–z. Length is measured in characters.',
    hint: 'Track the left boundary and the most recent position of each character. A repeated character outside the window must not move the boundary backward.',
    examples: [{ input: { text: 'abcabcbb' }, output: 3 }, { input: { text: 'abba' }, output: 2 }, { input: { text: '' }, output: 0 }],
  },
  'dsa-python-tree-level-order': {
    title: 'Tree Level Order', summary: 'Traverse a serialized binary tree breadth-first and group values by depth.', difficulty: 'intermediate', concepts: ['trees', 'queues', 'breadth-first search'],
    fields: [{ name: 'tree', type: 'nullableIntegers' }], result: 'matrix',
    contract: 'Return arrays of node values, one array per depth, left to right. tree is compact breadth-first serialization: after the root, each non-null queued parent consumes its next two child slots. Null slots do not consume children. This is NOT heap-index serialization. Trailing missing child slots are null. [] and [null] are empty trees.',
    constraints: 'tree has 0–63 slots, each null or an integer -50…50. Inputs describe a valid tree; unreachable non-null trailing slots never occur.',
    hint: 'Use a queue of real parents while reading child slots, then process one queue level at a time. Keep null placeholders out of the output.',
    examples: [{ input: { tree: [3,9,20,null,null,15,7] }, output: [[3],[9,20],[15,7]] }, { input: { tree: [1,null,2,3] }, output: [[1],[2],[3]] }, { input: { tree: [] }, output: [] }],
  },
  'dsa-python-number-islands': {
    title: 'Number of Islands', summary: 'Count connected land regions in a rectangular grid.', difficulty: 'intermediate', concepts: ['graphs', 'flood fill'],
    fields: [{ name: 'grid', type: 'strings' }], result: 'integer',
    contract: 'Each grid string is a row: 1 is land and 0 is water. Return the number of land components connected vertically or horizontally. Diagonals do not connect. Empty grids and zero-width rows contain no islands.',
    constraints: 'grid has 0–12 rows of equal width 0–12, containing only ASCII 0 and 1.',
    hint: 'Visit each land cell once with DFS or BFS. Explain why marking cells as visited when scheduling them avoids repeated work.',
    examples: [{ input: { grid: ['110','010','001'] }, output: 2 }, { input: { grid: ['10','01'] }, output: 2 }, { input: { grid: [] }, output: 0 }],
  },
  'dsa-python-coin-change': {
    title: 'Coin Change', summary: 'Find the fewest coins needed to make an exact amount.', difficulty: 'intermediate', concepts: ['dynamic programming', 'optimal substructure'],
    fields: [{ name: 'coins', type: 'integers' }, { name: 'amount', type: 'integer' }], result: 'integer',
    contract: 'Return the minimum number of coins whose values sum to amount, or -1 if impossible. Each denomination is available an unlimited number of times. Duplicates in coins have no extra meaning. Amount 0 needs 0 coins, including when coins is empty.',
    constraints: 'coins contains 0–12 positive integers 1–50; amount is an integer 0–200.',
    hint: 'Define the best answer for every smaller amount. Greedily taking the largest coin is not correct for arbitrary denominations.',
    examples: [{ input: { coins: [1,3,4], amount: 6 }, output: 2 }, { input: { coins: [2], amount: 3 }, output: -1 }, { input: { coins: [], amount: 0 }, output: 0 }],
  },
  'dsa-python-top-k': {
    title: 'Top K Frequent', summary: 'Rank distinct integers by frequency with a deterministic tie-break.', difficulty: 'intermediate', concepts: ['heaps', 'frequency maps', 'sorting'],
    fields: [{ name: 'nums', type: 'integers' }, { name: 'k', type: 'integer' }], result: 'integers',
    contract: 'Return the first k DISTINCT values ordered by descending frequency. Break frequency ties by ascending numeric value. If k exceeds the distinct-value count, return all distinct values in that order. k=0 returns [].',
    constraints: 'nums has 0–80 integers from -20 to 20; k is an integer 0–50.',
    hint: 'Separate counting from ordering. Explain the tradeoff between sorting all distinct values and maintaining a heap of candidates.',
    examples: [{ input: { nums: [1,1,2,2,3], k: 2 }, output: [1,2] }, { input: { nums: [-1,3,-1,3], k: 9 }, output: [-1,3] }, { input: { nums: [4], k: 0 }, output: [] }],
  },
  'dsa-python-linked-cycle': {
    title: 'Linked List Cycle', summary: 'Detect a cycle reachable from a linked-list head represented by next pointers.', difficulty: 'beginner', concepts: ['linked lists', 'two pointers'],
    fields: [{ name: 'next', type: 'integers' }, { name: 'head', type: 'integer' }], result: 'boolean',
    contract: 'Node i points to node next[i]; -1 ends the list. Return true only if repeatedly following next from head reaches a cycle. Cycles in unreachable nodes do not count. head=-1 is an empty list. Do not infer cycles from node values.',
    constraints: 'next contains 0–80 indices; every entry is -1 or a valid index. head is -1 or a valid index. For an empty array head is -1.',
    hint: 'Compare a visited-set solution with Floyd’s slow/fast pointers. Explain how to avoid dereferencing -1.',
    examples: [{ input: { next: [1,2,1], head: 0 }, output: true }, { input: { next: [-1,2,1], head: 0 }, output: false }, { input: { next: [], head: -1 }, output: false }],
  },
  'dsa-python-word-break': {
    title: 'Word Break', summary: 'Decide whether a string can be segmented into reusable dictionary words.', difficulty: 'advanced', concepts: ['dynamic programming', 'strings'],
    fields: [{ name: 'text', type: 'text' }, { name: 'words', type: 'strings' }], result: 'boolean',
    contract: 'Return whether text is a concatenation of zero or more words from words. Words may be reused; duplicates do not change the answer. The empty text is always segmentable, even with an empty dictionary. You must cover the entire text.',
    constraints: 'text has 0–40 lowercase ASCII letters; words has 0–20 entries of 1–8 lowercase ASCII letters each.',
    hint: 'Let a prefix state describe whether that prefix can be segmented. Trying the longest available word first can miss a valid segmentation.',
    examples: [{ input: { text: 'leetcode', words: ['leet','code'] }, output: true }, { input: { text: 'catsandog', words: ['cats','dog','sand','and','cat'] }, output: false }, { input: { text: '', words: [] }, output: true }],
  },
  'dsa-python-course-schedule': {
    title: 'Course Schedule', summary: 'Determine whether all courses can be completed under prerequisite constraints.', difficulty: 'advanced', concepts: ['graphs', 'topological sorting', 'cycle detection'],
    fields: [{ name: 'numCourses', type: 'integer' }, { name: 'prerequisites', type: 'matrix' }], result: 'boolean',
    contract: 'Courses are 0 through numCourses-1. Each pair [course,prerequisite] requires prerequisite before course. Return true if ALL courses can be completed. Self-dependencies and directed cycles make this false. Duplicate pairs are the same constraint, and disconnected courses must be considered.',
    constraints: 'numCourses is an integer 0–12; prerequisites has 0–40 valid pairs. When numCourses=0, prerequisites is empty and the result is true.',
    hint: 'Use an indegree queue or DFS visit states. Explain why a visited flag alone cannot distinguish an active recursion cycle from a completed branch.',
    examples: [{ input: { numCourses: 2, prerequisites: [[1,0]] }, output: true }, { input: { numCourses: 2, prerequisites: [[1,0],[0,1]] }, output: false }, { input: { numCourses: 0, prerequisites: [] }, output: true }],
  },
  'dsa-python-lru-cache': {
    title: 'LRU Cache', summary: 'Simulate a least-recently-used cache with reads, writes and eviction.', difficulty: 'advanced', concepts: ['design', 'hash maps', 'linked lists'],
    fields: [{ name: 'capacity', type: 'integer' }, { name: 'operations', type: 'matrix' }], result: 'integers',
    contract: 'Process operations in order: [0,key] is get and [1,key,value] is put. Return one result per get: its stored value or -1 if missing. A successful get or any put makes that key most recently used. Updating a key does not consume another slot. When a new key exceeds capacity, evict the least recently used key. Capacity 0 stores nothing.',
    constraints: 'capacity is an integer 0–8; operations has 0–40 valid rows; keys are integers -9…9 and values -100…100.',
    hint: 'Track recency independently of insertion order. Explain how a map plus a doubly linked list can support constant-time operations.',
    examples: [{ input: { capacity: 2, operations: [[1,1,10],[1,2,20],[0,1],[1,3,30],[0,2],[0,3]] }, output: [10,-1,30] }, { input: { capacity: 0, operations: [[1,1,7],[0,1]] }, output: [-1] }, { input: { capacity: 2, operations: [] }, output: [] }],
  },
  'dsa-python-median-stream': {
    title: 'Median from Stream', summary: 'Return the median after each arriving integer.', difficulty: 'advanced', concepts: ['heaps', 'streaming algorithms'],
    fields: [{ name: 'nums', type: 'integers' }], result: 'numbers',
    contract: 'Return an array containing the median of each nonempty prefix of nums, in arrival order. For even-sized prefixes use the arithmetic mean of the two middle values, without integer truncation. Duplicates and negative values count normally. Empty input returns [].',
    constraints: 'nums has 0–32 integers from -1000 to 1000. Medians are exact integers or halves; floating-point numbers are allowed.',
    hint: 'Maintain a lower and upper half with two heaps. Explain their size and ordering invariants, and how each incoming value preserves them.',
    examples: [{ input: { nums: [5,2,8,1] }, output: [5,3.5,5,3.5] }, { input: { nums: [-2,-1] }, output: [-2,-1.5] }, { input: { nums: [] }, output: [] }],
  },
  'dsa-python-edit-distance': {
    title: 'Edit Distance', summary: 'Find the minimum insertions, deletions and substitutions between two strings.', difficulty: 'advanced', concepts: ['dynamic programming', 'strings'],
    fields: [{ name: 'source', type: 'text' }, { name: 'target', type: 'text' }], result: 'integer',
    contract: 'Return the Levenshtein distance from source to target. Inserting, deleting or substituting one character each costs 1. Matching characters cost 0. Swapping adjacent characters is NOT a single allowed operation.',
    constraints: 'source and target each contain 0–40 lowercase ASCII letters.',
    hint: 'Define a state for two prefixes, with explicit empty-prefix base cases. Explain how to reduce the table to two rows.',
    examples: [{ input: { source: 'kitten', target: 'sitting' }, output: 3 }, { input: { source: 'ab', target: 'ba' }, output: 2 }, { input: { source: '', target: 'abc' }, output: 3 }],
  },
} satisfies Record<string, Specification>

export type ExtendedDSAId = keyof typeof extendedSpecifications
export const EXTENDED_DSA_IDS = Object.keys(extendedSpecifications) as ExtendedDSAId[]
export function isExtendedDSAId(id: string): id is ExtendedDSAId { return Object.hasOwn(extendedSpecifications, id) }
export function extendedSpecification(id: ExtendedDSAId): Specification { return extendedSpecifications[id] }

export const dsaTypes = {
  JavaScript: { integer: 'number', text: 'string', integers: 'number[]', nullableIntegers: '(number | null)[]', matrix: 'number[][]', strings: 'string[]', boolean: 'boolean', numbers: 'number[]' },
  TypeScript: { integer: 'number', text: 'string', integers: 'number[]', nullableIntegers: '(number | null)[]', matrix: 'number[][]', strings: 'string[]', boolean: 'boolean', numbers: 'number[]' },
  Python: { integer: 'int', text: 'str', integers: 'list[int]', nullableIntegers: 'list[int | None]', matrix: 'list[list[int]]', strings: 'list[str]', boolean: 'bool', numbers: 'list[float]' },
  Java: { integer: 'int', text: 'String', integers: 'int[]', nullableIntegers: 'Integer[]', matrix: 'int[][]', strings: 'String[]', boolean: 'boolean', numbers: 'double[]' },
  'C++': { integer: 'int', text: 'string', integers: 'vector<int>', nullableIntegers: 'vector<optional<int>>', matrix: 'vector<vector<int>>', strings: 'vector<string>', boolean: 'bool', numbers: 'vector<double>' },
}

export function extendedStarter(id: ExtendedDSAId, language: DSALanguage) {
  const spec = extendedSpecification(id), types = dsaTypes[language]
  const fields = spec.fields.map(field => `${field.name}: ${types[field.type]}`).join('; ')
  const todo = 'Complete the TODO before submitting'
  const comment = `${spec.title}. ${spec.contract}`
  if (language === 'Python') return `# ${comment}\n# value is a dict with ${fields}. Return ${types[spec.result]}.\ndef solve(value):\n    # TODO: implement the contract and explain your invariant.\n    raise NotImplementedError("${todo}")\n`
  if (language === 'Java') return `import java.util.*;\n// ${comment}\npublic class Main {\n  public static ${types[spec.result]} solve(${spec.fields.map(field => `${types[field.type]} ${field.name}`).join(', ')}) {\n    // TODO: keep this signature; return a result rather than printing.\n    throw new UnsupportedOperationException("${todo}");\n  }\n}\n`
  if (language === 'C++') return `#include <vector>\n#include <string>\n#include <optional>\n#include <stdexcept>\n#include <algorithm>\nusing namespace std;\n// ${comment}\n${types[spec.result]} solve(${spec.fields.map(field => field.type === 'integer' ? `int ${field.name}` : `const ${types[field.type]}& ${field.name}`).join(', ')}) {\n  // TODO: keep this signature; return a result rather than printing.\n  throw runtime_error("${todo}");\n}\n`
  return `// ${comment}\nexport function solve(value${language === 'TypeScript' ? `: { ${fields} }` : ''})${language === 'TypeScript' ? `: ${types[spec.result]}` : ''} {\n  // TODO: return a result rather than printing.\n  throw new Error('${todo}')\n}\n`
}

export function extendedDSAActivity(id: ExtendedDSAId): ActivityManifest {
  const spec = extendedSpecification(id)
  const variants = Object.fromEntries(DSA_LANGUAGES.map(language => [language, { starterFiles: [{ path: dsaEntryPath(language), content: extendedStarter(id, language) }], verify: { kind: 'rubric' as const } }]))
  return { id, title: spec.title, summary: spec.summary, mode: 'dsa', language: 'Python', source: 'curated', difficulty: spec.difficulty,
    concepts: [...spec.concepts, 'complexity analysis'], estimatedMinutes: spec.difficulty === 'advanced' ? 50 : 35,
    instructions: [spec.contract, spec.constraints, spec.hint, 'JavaScript, TypeScript and Python receive one value object/dictionary with the named fields. Java and C++ receive the separate parameters shown in their starter. Save before submitting. Server-controlled tests grade returned values, not learner-owned tests or printed scores. Explain time and space complexity separately; behavioral checks do not prove it.'],
    examples: spec.examples.map(example => ({ input: JSON.stringify(example.input), output: JSON.stringify(example.output) })),
    starterFiles: variants.Python.starterFiles, variants, verify: { kind: 'rubric' }, rubric: [{ id: 'correctness', label: 'All trusted behavioral cases pass', weight: 100 }] }
}
