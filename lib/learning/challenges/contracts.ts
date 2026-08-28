import type { ActivityManifest, Difficulty } from '../types'
import { dsaEntryPath, type DSALanguage } from '../dsa-foundations'
import { dsaTypes, type DSAFieldType, type DSAResultType, type ExtendedDSAInput } from '../dsa-extended'

export const CHALLENGE_KINDS = ['transform', 'validator', 'performance'] as const
export type ChallengeKind = typeof CHALLENGE_KINDS[number]
export const challengeTracks = { javascript: 'JavaScript', typescript: 'TypeScript', python: 'Python', java: 'Java', cpp: 'C++' } as const
type Track = keyof typeof challengeTracks
export type TrustedChallengeId = `challenge-${Track}-${ChallengeKind}`
export const TRUSTED_CHALLENGE_IDS = Object.keys(challengeTracks).flatMap(track => CHALLENGE_KINDS.map(kind => `challenge-${track}-${kind}` as TrustedChallengeId))
export function isTrustedChallengeId(id: string): id is TrustedChallengeId { return (TRUSTED_CHALLENGE_IDS as string[]).includes(id) }
export function challengeKind(id: TrustedChallengeId): ChallengeKind { return id.split('-').at(-1) as ChallengeKind }
export function challengeLanguage(id: TrustedChallengeId): DSALanguage { return challengeTracks[id.split('-')[1] as Track] }
export function hasTrustedChallengeGrader(id: string, language: string) { return isTrustedChallengeId(id) && challengeLanguage(id) === language }

interface Contract {
  title: string; summary: string; difficulty: Difficulty; concepts: string[];
  fields: {name: string; type: DSAFieldType}[]; result: DSAResultType;
  contract: string; bounds: string; explanation: string; hints: string[]; reflection: string[];
  examples: { input: ExtendedDSAInput; output: unknown }[];
}
export const challengeContracts: Record<ChallengeKind, Contract> = {
  transform: {
    title: 'Compact zero readings', summary: 'Move every zero reading to the end without changing the order of the nonzero readings.', difficulty: 'beginner',
    concepts: ['stable transformation', 'arrays', 'invariants'], fields: [{name:'nums',type:'integers'}], result:'integers',
    contract: 'Return an array of the same length containing all nonzero nums in their original relative order, followed by exactly as many zeros as were present. Preserve duplicates and negative values; do not sort or drop readings. Empty input returns [].',
    bounds: 'nums contains 0–200 integers from -1000 to 1000. Return the result; printing a score or changing local tests does not satisfy the contract.',
    explanation: 'A stable transformation preserves the order of items that remain. Separating the nonzero sequence from the count of zeros gives two useful invariants: output length never changes, and filtering zeros from either side gives the same sequence.',
    hints: ['Check both the values and the output length.', 'Keep duplicates and negative readings in the encounter order.', 'Collect nonzero values, then append the missing number of zeros.'],
    reflection: ['Which invariants distinguish stable compaction from sorting?', 'Compare a new-array implementation with in-place two-pointer compaction.'],
    examples: [{input:{nums:[0,3,0,-1,3]},output:[3,-1,3,0,0]},{input:{nums:[]},output:[]},{input:{nums:[0,0]},output:[0,0]}],
  },
  validator: {
    title: 'Validate a canonical IPv4 address', summary: 'Reject partial parsing, extra separators, signs and leading zeros using an exact text contract.', difficulty: 'intermediate',
    concepts: ['validation', 'parsing', 'boundary cases'], fields:[{name:'text',type:'text'}], result:'boolean',
    contract: 'Return true only for exactly four dot-separated decimal octets, each 0–255. Each octet contains only ASCII digits and has no leading zero unless it is exactly "0". Reject empty segments, signs, spaces, suffixes and additional separators. Do not trim or partially parse the text.',
    bounds: 'text contains 0–80 printable ASCII characters (space through ~), with no line breaks. This is a deliberately bounded string challenge, not a complete IP networking parser. Return a boolean, not a truthy string or number.',
    explanation: 'Parsing a numeric prefix is not validation of an entire field. Validate the structure and each complete octet before converting it. Checking decimal range alone misses signs, whitespace, leading zeros and strings whose numeric prefix is valid.',
    hints: ['Split into exactly four segments, including empty trailing segments.', 'Require each whole segment to be digits with the documented leading-zero rule.', 'Only then check the numeric upper bound of 255.'],
    reflection: ['Why can parseInt or a similar prefix parser accept invalid addresses?', 'Which rules belong to this contract rather than every possible IP-address notation?'],
    examples:[{input:{text:'192.168.1.1'},output:true},{input:{text:'01.2.3.4'},output:false},{input:{text:'255.255.255.256'},output:false}],
  },
  performance: {
    title: 'Count target-sum windows', summary: 'Count every nonempty contiguous window with the target sum, including overlapping windows and negative values.', difficulty:'advanced',
    concepts:['prefix sums','frequency maps','complexity analysis'], fields:[{name:'nums',type:'integers'},{name:'target',type:'integer'}],result:'integer',
    contract:'Return the number of pairs 0 <= start <= end < nums.length for which the contiguous slice nums[start..end] sums to target. Count overlaps and repeated equal prefixes separately. Empty slices never count. Empty input returns 0, including when target is 0.',
    bounds:'nums contains 0–10,000 integers from -10 to 10; target is -100,000…100,000. The result fits a signed 32-bit integer. Aim for O(n) time using prefix frequencies. Tests include large inputs within a 1.5-second per-case limit; passing does not prove asymptotic complexity.',
    explanation:'The sum between two prefix positions is their difference. When the current prefix is sum, each earlier prefix equal to sum-target identifies one window. Seed the empty prefix once, count matches before recording the current prefix, and retain frequencies rather than only a set.',
    hints:['Negative numbers make a simple monotonic sliding window unreliable.', 'How many earlier prefix sums equal current-target?', 'A frequency map counts repeated prefixes; inserting the current prefix too early can count an empty window.'],
    reflection:['Why must the empty prefix have an initial frequency of one?', 'Why does a set of prefix sums undercount, and what time/space bounds does a map achieve?'],
    examples:[{input:{nums:[1,1,1],target:2},output:2},{input:{nums:[0,0,0],target:0},output:6},{input:{nums:[1,-1,1],target:1},output:3}],
  },
}

export function challengeStarter(id: TrustedChallengeId) {
  const language=challengeLanguage(id), spec=challengeContracts[challengeKind(id)], types=dsaTypes[language]
  const comment=`${spec.title}. ${spec.contract}`
  const todo='Complete the TODO before submitting'
  if(language==='Python')return `# ${comment}\n# value is a dict with ${spec.fields.map(f=>f.name).join(', ')}.\ndef solve(value):\n    raise NotImplementedError("${todo}")\n`
  if(language==='Java')return `import java.util.*;\n// ${comment}\npublic class Main {\n  public static ${types[spec.result]} solve(${spec.fields.map(f=>`${types[f.type]} ${f.name}`).join(', ')}) {\n    throw new UnsupportedOperationException("${todo}");\n  }\n}\n`
  if(language==='C++')return `#include <vector>\n#include <string>\n#include <stdexcept>\nusing namespace std;\n// ${comment}\n${types[spec.result]} solve(${spec.fields.map(f=>f.type==='integer'?`int ${f.name}`:`const ${types[f.type]}& ${f.name}`).join(', ')}) {\n  throw runtime_error("${todo}");\n}\n`
  return `// ${comment}\nexport function solve(value${language==='TypeScript'?`: {${spec.fields.map(f=>`${f.name}: ${types[f.type]}`).join('; ')}}`:''})${language==='TypeScript'?`: ${types[spec.result]}`:''} {\n  throw new Error('${todo}')\n}\n`
}

export function trustedChallengeActivity(id: TrustedChallengeId): ActivityManifest {
  const spec=challengeContracts[challengeKind(id)],language=challengeLanguage(id)
  const instructions=[spec.contract,spec.bounds,'JavaScript, TypeScript and Python receive one object/dictionary with the named fields. Java and C++ receive separate typed parameters shown in the starter. Keep the signature and return a result; do not add a main program.', 'Save before submitting. Twenty-four private server-owned checks grade the retained entry file, not editable tests or package scripts. All 24 must pass for completion; partial scores count toward your best attempt. Record reasoning and complexity in REFLECTION.md; it does not change the automated score.']
  return {id,mode:'challenge',title:`${language}: ${spec.title}`,summary:spec.summary,language,source:'curated',difficulty:spec.difficulty,estimatedMinutes:spec.difficulty==='beginner'?30:spec.difficulty==='intermediate'?50:70,
    concepts:spec.concepts,instructions,lesson:{explanation:spec.explanation,hints:spec.hints,reflectionQuestions:spec.reflection},
    examples:spec.examples.map(x=>({input:JSON.stringify(x.input),output:JSON.stringify(x.output)})),
    starterFiles:[{path:dsaEntryPath(language),content:challengeStarter(id)},
      {path:'LESSON.md',content:`# ${spec.title}\n\n${instructions.join('\n\n')}\n\n## Examples\n${spec.examples.map(x=>`${JSON.stringify(x.input)} → ${JSON.stringify(x.output)}`).join('\n\n')}\n`},
      {path:'REFLECTION.md',content:`# Reflection\n\n${spec.reflection.map(q=>`## ${q}\n\nTODO: Explain with an example.`).join('\n\n')}\n`}],
    verify:{kind:'rubric'},rubric:[{id:'correctness',label:'All 24 server-owned behavioral checks pass',weight:100}],
  }
}
