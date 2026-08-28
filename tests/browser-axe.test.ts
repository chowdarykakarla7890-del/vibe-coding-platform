import { createRequire } from 'node:module'
import { expect, it, vi } from 'vitest'
import { isolatedAxeSource } from '@/scripts/browser-axe.mjs'

const { JSDOM } = createRequire(import.meta.url)('jsdom')

it('reproduces repeated axe scans registering with an application AMD loader', () => {
  const require = createRequire(import.meta.url)
  const { source } = createRequire(require.resolve('@axe-core/playwright'))('axe-core')
  const dom = new JSDOM('', { runScripts: 'outside-only' })
  try {
    const define = Object.assign(vi.fn(), { amd: {} })
    Object.assign(dom.window, { define })
    dom.window.eval(source); dom.window.eval(source)
    expect(define).toHaveBeenCalledTimes(2)
    expect(define.mock.calls.every(args => args[0] === 'axe-core')).toBe(true)
  } finally { dom.window.close() }
})

it('retains axe and repeated scans without touching the page’s module registry', () => {
  const dom = new JSDOM('', { runScripts: 'outside-only' })
  try {
    const define = Object.assign(vi.fn(), { amd: {} }), require = vi.fn()
    const pageModule = { exports: {} }, pageExports = {}
    Object.assign(dom.window, { define, require, module: pageModule, exports: pageExports })
    dom.window.eval(isolatedAxeSource); dom.window.eval(isolatedAxeSource)
    expect(dom.window.eval('typeof window.axe.run')).toBe('function')
    expect(dom.window.eval('window.axe.getRules().length')).toBeGreaterThan(100)
    expect(define).not.toHaveBeenCalled()
    expect(require).not.toHaveBeenCalled()
    expect(dom.window.eval('window.define')).toBe(define)
    expect(dom.window.eval('window.require')).toBe(require)
    expect(dom.window.eval('window.module')).toBe(pageModule)
    expect(pageModule.exports).toEqual({})
    expect(dom.window.eval('window.exports')).toBe(pageExports)
  } finally { dom.window.close() }
})
