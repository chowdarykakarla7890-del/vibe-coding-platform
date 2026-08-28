import { describe, expect, it } from 'vitest'
import {
  CHALLENGE_ACTIVITIES,
  CURATED_ACTIVITIES,
  DEBUG_ACTIVITIES,
  DSA_ACTIVITIES,
  PRACTICE_ACTIVITIES,
  PROJECT_ACTIVITIES,
} from '../lib/learning/catalog'
import { activityManifestSchema } from '../lib/learning/types'
import { isActivityRouteValid } from '../lib/learning/activity-route'

describe('curated learning catalog', () => {
  it('ships the promised number of activities', () => {
    expect(PRACTICE_ACTIVITIES).toHaveLength(18)
    expect(DEBUG_ACTIVITIES).toHaveLength(12)
    expect(CHALLENGE_ACTIVITIES).toHaveLength(18)
    expect(PROJECT_ACTIVITIES).toHaveLength(6)
    expect(DSA_ACTIVITIES).toHaveLength(15)
  })

  it('contains unique, valid manifests', () => {
    expect(new Set(CURATED_ACTIVITIES.map((activity) => activity.id)).size).toBe(CURATED_ACTIVITIES.length)
    for (const activity of CURATED_ACTIVITIES) {
      expect(activityManifestSchema.safeParse(activity).success).toBe(true)
    }
  })

  it('offers all five requested DSA template languages', () => {
    for (const activity of DSA_ACTIVITIES) {
      expect(Object.keys(activity.variants ?? {})).toEqual([
        'JavaScript',
        'TypeScript',
        'Python',
        'Java',
        'C++',
      ])
    }
  })

  it('marks unimplemented command starters (Debug behavior is exercised by debug-catalog tests)', () => {
    for (const activity of CURATED_ACTIVITIES) {
      if (activity.mode === 'debug') continue
      if (activity.verify.kind === 'command') {
        expect(activity.starterFiles.some((file) => /Complete the TODO/.test(file.content))).toBe(true)
      }
      for (const variant of Object.values(activity.variants ?? {})) {
        if (variant.verify.kind === 'command') {
          expect(variant.starterFiles.some((file) => /Complete the TODO/.test(file.content))).toBe(true)
        }
      }
    }
  })

  it('rejects unsafe or duplicate generated starter paths', () => {
    const base = {
      ...CURATED_ACTIVITIES[0],
      id: 'generated-path-validation',
      source: 'generated' as const,
    }

    expect(
      activityManifestSchema.safeParse({
        ...base,
        starterFiles: [{ path: '../secret.txt', content: 'no' }],
      }).success
    ).toBe(false)

    expect(
      activityManifestSchema.safeParse({
        ...base,
        starterFiles: [
          { path: 'src/index.ts', content: 'one' },
          { path: 'src/index.ts', content: 'two' },
        ],
      }).success
    ).toBe(false)
  })

  it('keeps curated and generated activities inside their matching route', () => {
    const practice = PRACTICE_ACTIVITIES[0]
    expect(isActivityRouteValid(practice.id, 'practice')).toBe(true)
    expect(isActivityRouteValid(practice.id, 'debug')).toBe(false)
    expect(isActivityRouteValid('generated-debug-example', 'debug')).toBe(true)
    expect(isActivityRouteValid('generated-debug-example', 'practice')).toBe(false)
    expect(isActivityRouteValid('missing-activity', 'practice')).toBe(false)
  })
})
