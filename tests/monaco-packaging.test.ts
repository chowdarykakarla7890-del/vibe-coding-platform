import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { installedMonaco, prepareMonaco } from '@/scripts/prepare-monaco.mjs'
import { MONACO_VERSION } from '@/lib/editor/runtime'
import { config } from '@/proxy'
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(pin = '0.56.0', installed = pin, incomplete = false) {
  const root = mkdtempSync(join(tmpdir(), 'codetutor-monaco-test-')); roots.push(root)
  const pkg = join(root, 'node_modules', 'monaco-editor')
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'monaco-editor': pin } }))
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'monaco-editor', version: installed, exports: { '.': './index.js' } }))
  writeFileSync(join(pkg, 'index.js'), '// fake exported entry')
  const paths = ['min/vs/loader.js', 'min/vs/editor/editor.main.js', 'min/vs/editor/editor.worker.js', 'min/vs/language/typescript/tsWorker.js', 'LICENSE', 'ThirdPartyNotices.txt']
  for (const path of incomplete ? paths.slice(0, 1) : paths) {
    mkdirSync(dirname(join(pkg, path)), { recursive: true }); writeFileSync(join(pkg, path), `fixture ${path}`)
  }
  return { root, pkg }
}

it('resolves the actual installed package despite its private package.json export', () => {
  expect(installedMonaco().pin).toBe(MONACO_VERSION)
  expect(existsSync(join(installedMonaco().source, 'min/vs/loader.js'))).toBe(true)
})

it('packages loader, workers, language assets and notices from the installed pin', () => {
  const { root, pkg } = fixture()
  expect(prepareMonaco(root)).toEqual({ version: '0.56.0', path: '/vendor/monaco/0.56.0/vs' })
  for (const path of ['vs/loader.js', 'vs/editor/editor.worker.js', 'vs/language/typescript/tsWorker.js']) {
    expect(readFileSync(join(root, 'public/vendor/monaco/0.56.0', path), 'utf8')).toBe(readFileSync(join(pkg, 'min', path), 'utf8'))
  }
  expect(existsSync(join(root, 'public/vendor/monaco/0.56.0/LICENSE'))).toBe(true)
  expect(existsSync(join(root, 'public/vendor/monaco/0.56.0/package.json'))).toBe(false)
  expect(() => prepareMonaco(root)).not.toThrow()
})

it.each([['^0.56.0', '0.56.0', false], ['0.56.0', '0.55.1', false], ['0.56.0', '0.56.0', true]] as const)('refuses unsafe or incomplete packages (%s/%s/%s)', (pin, installed, incomplete) => {
  const { root } = fixture(pin, installed, incomplete)
  expect(() => prepareMonaco(root)).toThrow()
  expect(existsSync(join(root, 'public'))).toBe(false)
})

it('serves only the public editor prefix without session redirects while keeping workspaces protected', () => {
  for (const url of ['/vendor/monaco/0.56.0/vs/loader.js', '/vendor/monaco/0.56.0/vs/editor/editor.worker.js']) {
    expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })).toBe(false)
  }
  for (const url of ['/playground', '/vendor/monaco-private', '/projects/123', '/sign-in']) {
    expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })).toBe(true)
  }
})
