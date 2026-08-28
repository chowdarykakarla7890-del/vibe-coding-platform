import type { Difficulty, ProgressRecord } from './types'

export const difficultyWeight: Record<Difficulty, number> = {
  beginner: 1,
  intermediate: 1.5,
  advanced: 2,
}

export function calculateMastery(
  records: Array<ProgressRecord & { difficulty: Difficulty }>
) {
  const totalWeight = records.reduce(
    (sum, record) => sum + difficultyWeight[record.difficulty],
    0
  )
  if (totalWeight === 0) return 0
  const earned = records.reduce(
    (sum, record) =>
      sum + (record.bestScore / 100) * difficultyWeight[record.difficulty],
    0
  )
  return Math.round((earned / totalWeight) * 100)
}

export const allowedExecutables = new Set([
  'node',
  'npm',
  'pnpm',
  'npx',
  'python',
  'python3',
  'pytest',
  'javac',
  'java',
  'g++',
])

export function isSafeCommand(executable: string, args: string[]) {
  if (!allowedExecutables.has(executable) || args.length > 24) return false
  return args.every(
    (arg) =>
      arg.length <= 240 &&
      !/[\n\r\0]/.test(arg) &&
      !arg.startsWith('/') &&
      !arg.includes('..')
  )
}
