import { describe, expect, it } from 'vitest'
import { buildFileTree } from '@/components/file-explorer/build-file-tree'

describe('saved workspace file tree', () => {
  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])('renders %s as an ordinary file name', (name) => {
    expect(buildFileTree([name])).toMatchObject([{ name, path: `/${name}`, type: 'file' }])
  })

  it.each(['__proto__', 'constructor', 'toString'])('can open a folder named %s without crashing or changing object prototypes', (name) => {
    const before = Object.getOwnPropertyDescriptors(Object.prototype)
    expect(buildFileTree([`${name}/page.tsx`])).toMatchObject([
      { name, type: 'folder', children: [{ name: 'page.tsx', type: 'file' }] },
    ])
    expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(before)
  })

  it('merges stale file/folder entries deterministically instead of crashing the app', () => {
    const paths = ['src', 'src/page.tsx', 'src/', 'src/page.tsx', 'README.md']
    const tree = buildFileTree(paths)
    expect(tree).toEqual(buildFileTree([...paths].reverse()))
    expect(tree).toMatchObject([
      { name: 'src', type: 'folder', content: undefined, children: [{ name: 'page.tsx', type: 'file' }] },
      { name: 'README.md', type: 'file' },
    ])
  })

  it('keeps empty folders and legacy leading-slash paths, without duplicate nodes', () => {
    expect(buildFileTree(['empty/', '/app/page.tsx', 'app/page.tsx'])).toMatchObject([
      { name: 'app', type: 'folder', children: [{ name: 'page.tsx', type: 'file' }] },
      { name: 'empty', type: 'folder', children: [] },
    ])
  })
})
