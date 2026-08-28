import type { GradingSummary } from '@/lib/learning/grading-evidence'

export const gradingSummary: GradingSummary = {
  version: 1, checkVersion: 'dsa-catalog-v2', planDigest: 'd'.repeat(64),
  sourceDigest: 'a'.repeat(64), harnessDigest: 'b'.repeat(64), runtimeDigest: 'c'.repeat(64),
  caseCount: 24, status: 'complete', passedCount: 23, compileFailure: null,
  outcomes: [...Array.from({ length: 23 }, () => 'passed' as const), 'wrong-answer'],
  createdAt: '2026-08-27T00:00:00Z', completedAt: '2026-08-27T00:01:00Z',
}
