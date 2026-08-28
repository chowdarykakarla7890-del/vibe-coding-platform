import { expect, it, vi } from 'vitest'
import { labelDiffEditors } from '@/lib/editor/accessibility'

function fixture(label: string) {
  const listeners = new Set<() => void>()
  const emit = () => listeners.forEach(listener => listener())
  return {
    listeners,
    getOption: () => label,
    updateOptions: vi.fn((options: { ariaLabel: string }) => { label = options.ariaLabel; emit() }),
    onDidChangeConfiguration: (listener: () => void) => {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
    clearLabel: () => { label = ''; emit() },
    emit,
  }
}

it('repairs names cleared by diff option updates, without looping or touching valid help suffixes', () => {
  const original = fixture(''), modified = fixture('Your draft use Alt+F1 for help')
  let dispose!: () => void
  labelDiffEditors({ getOriginalEditor: () => original, getModifiedEditor: () => modified,
    onDidDispose: (callback: () => void) => { dispose = callback } } as never,
  { editor: { EditorOption: { ariaLabel: 4 } } } as never)
  expect(original.getOption()).toBe('Saved version')
  expect(original.updateOptions).toHaveBeenCalledOnce()
  expect(modified.updateOptions).not.toHaveBeenCalled()
  original.emit(); modified.emit()
  expect(original.updateOptions).toHaveBeenCalledOnce()
  original.clearLabel(); modified.clearLabel()
  expect(original.getOption()).toBe('Saved version')
  expect(modified.getOption()).toBe('Your draft')
  expect(original.updateOptions).toHaveBeenCalledTimes(2)
  expect(modified.updateOptions).toHaveBeenCalledOnce()
  dispose()
  expect(original.listeners.size).toBe(0)
  expect(modified.listeners.size).toBe(0)
  original.clearLabel()
  expect(original.updateOptions).toHaveBeenCalledTimes(2)
})
