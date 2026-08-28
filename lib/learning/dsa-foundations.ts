import type { ActivityManifest } from './types'

export const FOUNDATION_DSA_IDS = ['dsa-python-two-sum', 'dsa-python-valid-parentheses', 'dsa-python-binary-search'] as const
export type FoundationDSAId = typeof FOUNDATION_DSA_IDS[number]
export const DSA_LANGUAGES = ['JavaScript', 'TypeScript', 'Python', 'Java', 'C++'] as const
export type DSALanguage = typeof DSA_LANGUAGES[number]

const specifications: Record<FoundationDSAId, { title: string; summary: string; instructions: string[]; concepts: string[]; examples: { input: string; output: string }[] }> = {
  'dsa-python-two-sum': {
    title: 'Two Sum', summary: 'Find two different array positions whose values add to a target.', concepts: ['arrays', 'hash maps', 'complexity analysis'],
    instructions: [
      'Implement solve for an integer array nums and integer target. Return two distinct zero-based indices whose values sum to target, or an empty array if no pair exists. Any valid pair and either index order are accepted.',
      'Inputs contain 0–200 integers, each from -1000 to 1000. The target is from -2000 to 2000. Duplicates and negative values are allowed; the same array position cannot be reused.',
      'Start with a small example, then consider a map of values already seen. Explain the time and space tradeoff between a nested scan and a map.',
      'Save your implementation before submitting. Trusted checks use the retained source, including cases beyond the examples; editing or deleting local tests cannot award points.',
    ],
    examples: [{ input: '{"nums":[2,7,11,15],"target":9}', output: '[0,1]' }, { input: '{"nums":[3,3],"target":6}', output: '[0,1]' }, { input: '{"nums":[1],"target":2}', output: '[]' }],
  },
  'dsa-python-valid-parentheses': {
    title: 'Valid Parentheses', summary: 'Use a stack to validate matching and correctly nested brackets.', concepts: ['stacks', 'invariants', 'complexity analysis'],
    instructions: [
      'Implement solve for a string containing only (, ), [, ], { and }. Return true exactly when every opening bracket has a matching closing bracket in the correct nesting order.',
      'The empty string is valid. Inputs have length 0–200. A closing bracket cannot be matched to a different bracket type or to an opening bracket that appears later.',
      'Trace the stack for ([{}]) and ([)]. Explain why comparing only opening and closing counts is insufficient.',
      'Save your implementation before submitting. Trusted checks compare actual returned values against server-side expectations; local test output is not a score.',
    ],
    examples: [{ input: '"([{}])"', output: 'true' }, { input: '"([)]"', output: 'false' }, { input: '""', output: 'true' }],
  },
  'dsa-python-binary-search': {
    title: 'Binary Search', summary: 'Locate the first matching position in a sorted array, including duplicates.', concepts: ['binary search', 'loop invariants', 'complexity analysis'],
    instructions: [
      'Implement solve for a sorted, nondecreasing integer array nums and integer target. Return the first zero-based index equal to target, or -1 if the target is absent.',
      'Inputs contain 0–200 integers from -1000 to 1000; duplicates are allowed. The target is from -2000 to 2000. Do not assume there is exactly one match.',
      'Use a shrinking search interval and describe its invariant. Aim for O(log n) comparisons and O(1) extra space. Correctness checks do not prove asymptotic complexity; explain it in your reflection.',
      'Save your implementation before submitting. Trusted checks include empty arrays, boundary positions and repeated values.',
    ],
    examples: [{ input: '{"nums":[-2,0,0,4],"target":0}', output: '1' }, { input: '{"nums":[],"target":3}', output: '-1' }, { input: '{"nums":[1,3,5],"target":4}', output: '-1' }],
  },
}

export function isFoundationDSAId(id: string): id is FoundationDSAId { return (FOUNDATION_DSA_IDS as readonly string[]).includes(id) }
export function isDSALanguage(language: string): language is DSALanguage { return (DSA_LANGUAGES as readonly string[]).includes(language) }
export function dsaEntryPath(language: DSALanguage) {
  return { JavaScript: 'src/main.mjs', TypeScript: 'src/main.ts', Python: 'src/main.py', Java: 'Main.java', 'C++': 'src/main.cpp' }[language]
}

function starter(id: FoundationDSAId, language: DSALanguage) {
  const brackets = id.endsWith('valid-parentheses'), pair = id.endsWith('two-sum')
  const comment = `${specifications[id].title}: ${brackets ? 'Return whether brackets are correctly nested.' : pair ? 'Return any valid pair of distinct indices, or an empty array.' : 'Return the FIRST matching index, or -1.'}`
  if (language === 'Python') return `# ${comment}\n# input is ${brackets ? 'a bracket string' : 'a dict with nums (list[int]) and target (int)'}.\ndef solve(value):\n    # TODO: implement and explain your invariant.\n    raise NotImplementedError("Complete the TODO before submitting")\n`
  if (language === 'Java') return `// ${comment}\npublic class Main {\n  public static ${brackets ? 'boolean' : pair ? 'int[]' : 'int'} solve(${brackets ? 'String value' : 'int[] nums, int target'}) {\n    // TODO: implement without changing the signature.\n    throw new UnsupportedOperationException("Complete the TODO before submitting");\n  }\n}\n`
  if (language === 'C++') return `#include <vector>\n#include <string>\n#include <stdexcept>\nusing namespace std;\n// ${comment}\n${brackets ? 'bool' : pair ? 'vector<int>' : 'int'} solve(${brackets ? 'const string& value' : 'const vector<int>& nums, int target'}) {\n  // TODO: implement without changing the signature.\n  throw runtime_error("Complete the TODO before submitting");\n}\n`
  const annotation = language === 'TypeScript' ? brackets ? ': string' : ': { nums: number[]; target: number }' : ''
  const result = language === 'TypeScript' ? brackets ? ': boolean' : pair ? ': number[]' : ': number' : ''
  return `// ${comment}\nexport function solve(value${annotation})${result} {\n  // TODO: implement without changing the signature.\n  throw new Error('Complete the TODO before submitting')\n}\n`
}

export function foundationDSAActivity(id: FoundationDSAId): ActivityManifest {
  const spec = specifications[id]
  const variants = Object.fromEntries(DSA_LANGUAGES.map(language => [language, {
    starterFiles: [{ path: dsaEntryPath(language), content: starter(id, language) }],
    // The manifest does not grant execution authority. The server's exact
    // curated-ID registry selects the independent trusted runner.
    verify: { kind: 'rubric' as const },
  }]))
  return { id, mode: 'dsa', ...spec, language: 'Python', difficulty: 'beginner', estimatedMinutes: 30,
    source: 'curated', starterFiles: variants.Python.starterFiles, variants,
    verify: { kind: 'rubric' }, rubric: [{ id: 'correctness', label: 'All trusted behavioral cases pass', weight: 100 }] }
}
