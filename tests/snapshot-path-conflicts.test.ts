import { describe, expect, it } from 'vitest'
import { hasSnapshotPathConflict } from '@/lib/learning/snapshots'

describe('snapshot file/directory namespace', () => {
  it.each([
    ['src', 'src/page.ts'],
    ['src/page.ts', 'src'],
    ['app/config', 'app/config/nested/options.json'],
    ['constructor', 'constructor/file.ts'],
    ['__proto__', '__proto__/file.ts'],
  ])('detects a file used as a parent directory (%j)', (...paths) => {
    expect(hasSnapshotPathConflict(paths)).toBe(true)
  })

  it.each([
    ['src', 'src-other/page.ts'],
    ['app/a.ts', 'app/b.ts'],
    ['app', 'App/file.ts'],
    ['%_', '%_other/file.ts'],
    ['__proto__/a.ts', 'constructor/b.ts'],
    [],
  ])('does not confuse sibling names or literal characters (%j)', (...paths) => {
    expect(hasSnapshotPathConflict(paths)).toBe(false)
  })
})
