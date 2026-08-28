import 'server-only'
import { randomInt } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { TrustedDSAId } from '@/lib/learning/dsa'
import { isExtendedDSAId, type ExtendedDSAInput } from '@/lib/learning/dsa-extended'
import { extendedCases, expectedExtendedResult } from './dsa-extended-cases'

export type DSACase = { input: string | ExtendedDSAInput; label: string }
export const DSA_CHECK_VERSION = 'dsa-catalog-v2'

export function dsaCases(id: TrustedDSAId, integer: (min: number, max: number) => number = randomInt): DSACase[] {
  if (isExtendedDSAId(id)) return extendedCases(id, integer)
  if (id.endsWith('valid-parentheses')) {
    const values = ['', '()', '[]{}()', '([{}])', '([)]', '(', ')', '}{', '((', '(()', '())', '{[()]}[]']
    for (let i = 0; i < 6; i++) {
      const n = integer(1, 40), pair = ['()', '[]', '{}'][integer(0, 3)]
      values.push(pair[0].repeat(n) + pair[1].repeat(n))
      values.push(pair[0].repeat(n) + pair[1].repeat(n - 1))
    }
    return values.map((input, index) => ({ input, label: index < 12 ? 'boundary and nesting' : 'generated nesting' }))
  }
  const inputs = [
    { nums: [], target: 0 }, { nums: [1], target: 2 }, { nums: [3, 3], target: 6 },
    { nums: [-3, 4, 3, 90], target: 0 }, { nums: [0, 0, 0], target: 0 },
    { nums: [1, 3, 5, 7], target: 8 }, { nums: [1, 3, 5, 7], target: 7 },
    { nums: [-5, -5, -5, -1], target: -5 }, { nums: [1000, -1000], target: 0 },
    { nums: [1, 3, 4], target: -10 }, { nums: [1, 3, 4], target: 10 }, { nums: [1, 3, 4], target: 3 },
  ]
  for (let i = 0; i < 12; i++) {
    const nums = Array.from({ length: integer(2, 201) }, () => integer(-1000, 1001))
    const target = i % 2 === 0 ? (id.endsWith('two-sum') ? nums[0] + nums[1] : nums[0]) : integer(-2000, 2001)
    inputs.push({ nums, target })
  }
  if (id.endsWith('binary-search')) inputs.forEach(value => value.nums.sort((a, b) => a - b))
  return inputs.map((input, index) => ({ input, label: index < 12 ? 'boundary and duplicates' : 'generated integer arrays' }))
}

/** Expected answers never enter the sandbox, and no stdout claim is trusted. */
export function judgeDSAResult(id: TrustedDSAId, input: DSACase['input'], actual: unknown): boolean {
  if (isExtendedDSAId(id)) return typeof input !== 'string' && isDeepStrictEqual(actual, expectedExtendedResult(id, input))
  if (id.endsWith('valid-parentheses')) {
    if (typeof input !== 'string' || typeof actual !== 'boolean') return false
    const stack: string[] = [], open = '([{', close = ')]}'
    let valid = true
    for (const char of input) {
      const index = open.indexOf(char)
      if (index >= 0) stack.push(char)
      else if (stack.pop() !== open[close.indexOf(char)]) { valid = false; break }
    }
    return actual === (valid && stack.length === 0)
  }
  if (typeof input === 'string' || !Array.isArray(input.nums) || typeof input.target !== 'number') return false
  const nums = input.nums as number[], target = input.target
  if (id.endsWith('binary-search')) return isDeepStrictEqual(actual, nums.indexOf(target))
  if (!Array.isArray(actual)) return false
  if (actual.length === 0) {
    for (let a = 0; a < nums.length; a++) for (let b = a + 1; b < nums.length; b++) if (nums[a] + nums[b] === target) return false
    return true
  }
  if (actual.length !== 2 || actual.some(index => !Number.isInteger(index) || index < 0 || index >= nums.length) || actual[0] === actual[1]) return false
  return nums[actual[0]] + nums[actual[1]] === target
}
