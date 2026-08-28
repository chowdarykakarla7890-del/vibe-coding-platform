import { expect, it } from 'vitest'
import { browserDiagnostic } from '@/scripts/browser-diagnostics.mjs'

it('classifies known library failures without exposing their payloads', () => {
  expect(browserDiagnostic('TextModel got disposed before DiffEditorWidget model got reset', 'at f (http://localhost:3010/vendor/monaco/0.56.0/vs/editor-KLE6jdfb.js:3:24)')).toEqual({ category: 'diff-model-disposed', library: 'editor-KLE6jdfb.js', line: 3, column: 24 })
  expect(browserDiagnostic('monospace assumptions have been violated, therefore disabling monospace optimizations!')).toEqual({ category: 'monospace-measurement' })
  expect(browserDiagnostic("Duplicate definition of module 'vs/editor/editor.main'")).toEqual({ category: 'duplicate-module', module: 'vs/editor/editor.main' })
})

it('does not emit unknown messages, auth URLs or query parameters', () => {
  const secret = 'not-a-real-secret'
  expect(JSON.stringify(browserDiagnostic(`Provider ${secret}`, `http://localhost/auth/callback?code=${secret}`))).not.toContain(secret)
  expect(browserDiagnostic('unknown error', `http://localhost/vendor/monaco/0.56.0/vs/editor/editor.main.js?code=${secret}`)).toEqual({ category: 'other', library: 'editor.main.js' })
  expect(browserDiagnostic(`Duplicate definition of module 'vs/editor?code=${secret}'`)).toEqual({ category: 'duplicate-module' })
})
