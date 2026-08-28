import { describe, expect, it } from 'vitest'
import { calculateMastery, isSafeCommand } from '../lib/learning/scoring'

describe('learning scoring', () => {
  it('weights advanced best scores more heavily', () => {
    const mastery = calculateMastery([
      { activityId: 'a', attempts: 1, completed: true, bestScore: 100, concepts: [], updatedAt: 1, difficulty: 'beginner' },
      { activityId: 'b', attempts: 1, completed: false, bestScore: 50, concepts: [], updatedAt: 1, difficulty: 'advanced' },
    ])
    expect(mastery).toBe(67)
  })

  it('accepts structured allowlisted runners and rejects traversal or shells', () => {
    expect(isSafeCommand('python3', ['src/main.py'])).toBe(true)
    expect(isSafeCommand('sh', ['-lc', 'rm -rf /'])).toBe(false)
    expect(isSafeCommand('node', ['../secret.js'])).toBe(false)
    expect(isSafeCommand('node', ['/etc/passwd'])).toBe(false)
  })
})
