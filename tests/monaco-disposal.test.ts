import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'

// Exercise the installed wrapper's actual pinned cleanup function, not a mock
// copy. Both entrypoints must retain this order after a clean frozen install.
const dist = dirname(createRequire(import.meta.url).resolve('@monaco-editor/react'))
for (const [file, reference, keepOriginal, keepModified] of [
  ['index.mjs', 'u', 'g', 'N'], ['index.js', 'p', 'R', 'j'],
] as const) {
  const source = readFileSync(join(dist, file), 'utf8')
  const cleanup = source.match(/function [A-Za-z]+\(\)\{let [^}]+?original[^}]+?dispose[^}]+\}/)?.[0]
  it.each([[false, false], [true, false], [false, true], [true, true]])(`${file} detaches diff models before disposal (keep %s/%s)`, (originalKept, modifiedKept) => {
    expect(cleanup).toBeDefined()
    const calls: string[] = []
    let attached = true
    const disposeModel = (name: string) => vi.fn(() => {
      expect(attached).toBe(false)
      calls.push(name)
    })
    const original = disposeModel('original'), modified = disposeModel('modified')
    const editor = {
      getModel: () => ({ original: { dispose: original }, modified: { dispose: modified } }),
      setModel: (model: unknown) => { expect(model).toBeNull(); attached = false; calls.push('detach') },
      dispose: () => calls.push('editor'),
    }
    runInNewContext(`(${cleanup})()`, { [reference]: { current: editor }, [keepOriginal]: originalKept, [keepModified]: modifiedKept })
    expect(calls).toEqual(['detach', ...originalKept ? [] : ['original'], ...modifiedKept ? [] : ['modified'], 'editor'])
    expect(original).toHaveBeenCalledTimes(originalKept ? 0 : 1)
    expect(modified).toHaveBeenCalledTimes(modifiedKept ? 0 : 1)
  })
  it(`${file} tolerates disposal before an editor exists`, () => {
    expect(() => runInNewContext(`(${cleanup})()`, { [reference]: { current: null }, [keepOriginal]: false, [keepModified]: false })).not.toThrow()
  })
}
