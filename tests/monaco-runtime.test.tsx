// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import MonacoEditor, { MonacoDiffEditor } from '@/components/file-explorer/monaco-runtime'
import { MONACO_ASSET_PATH, MONACO_LOAD_TIMEOUT_MS, MONACO_VERSION } from '@/lib/editor/runtime'
import { dependencies } from '../package.json'

const mocked = vi.hoisted(() => ({ config: vi.fn(), init: vi.fn() }))
vi.mock('@monaco-editor/react', () => ({
  loader: mocked,
  default: ({ value }: { value: string }) => <div data-testid="monaco-editor">{value}</div>,
  DiffEditor: ({ original, modified }: { original: string; modified: string }) => <div data-testid="monaco-diff">{original} → {modified}</div>,
}))
beforeEach(() => { vi.useFakeTimers(); mocked.init.mockReset() })
afterEach(() => { cleanup(); vi.useRealTimers() })

it('configures the exact installed pin on this deployment, never the upstream CDN', () => {
  expect(MONACO_VERSION).toBe(dependencies['monaco-editor'])
  expect(mocked.config).toHaveBeenCalledWith({ paths: { vs: `/vendor/monaco/${MONACO_VERSION}/vs` } })
  expect(MONACO_ASSET_PATH.startsWith('/')).toBe(true)
})

it('loads real editor and diff components only after runtime readiness', async () => {
  let resolve!: () => void
  mocked.init.mockReturnValue(new Promise<void>(done => { resolve = done }))
  const view = render(<MonacoEditor value="saved source" />)
  expect(screen.getByRole('status').textContent).toContain('Loading code editor')
  expect(screen.queryByTestId('monaco-editor')).toBeNull()
  await act(async () => resolve())
  expect(screen.getByTestId('monaco-editor').textContent).toBe('saved source')
  mocked.init.mockResolvedValue({})
  view.rerender(<MonacoDiffEditor original="saved source" modified="draft" />)
  await act(async () => {})
  expect(screen.getByTestId('monaco-diff').textContent).toContain('draft')
  expect(vi.getTimerCount()).toBe(0)
})

it.each(['rejected', 'throws', 'timeout'])('offers basic editing when runtime %s without losing the draft', async failure => {
  let resolve!: () => void
  if (failure === 'rejected') mocked.init.mockImplementation(() => Promise.reject(new Error('opaque URL')))
  else if (failure === 'throws') mocked.init.mockImplementation(() => { throw new Error('opaque URL') })
  else mocked.init.mockReturnValue(new Promise<void>(done => { resolve = done }))
  const onChange = vi.fn(), onSave = vi.fn()
  render(<MonacoEditor value="unsaved draft" onChange={onChange} onSave={onSave} />)
  await act(async () => { await vi.advanceTimersByTimeAsync(MONACO_LOAD_TIMEOUT_MS) })
  const input = screen.getByRole('textbox', { name: 'Source editor (basic mode)' }) as HTMLTextAreaElement
  expect(input.value).toBe('unsaved draft')
  expect(screen.getByRole('status').textContent).not.toContain('opaque URL')
  fireEvent.change(input, { target: { value: 'continued work' } })
  expect(onChange).toHaveBeenLastCalledWith('continued work')
  fireEvent.keyDown(input, { key: 's', ctrlKey: true })
  expect(onSave).toHaveBeenCalledOnce()
  if (resolve) await act(async () => resolve())
  // A late download must not replace the focused basic editor underneath typing.
  expect(screen.queryByTestId('monaco-editor')).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
})

it('preserves read-only expired source and both comparison buffers in basic mode', async () => {
  mocked.init.mockRejectedValue(new Error('unavailable'))
  const onSave = vi.fn()
  const view = render(<MonacoEditor value="expired source" options={{ readOnly: true }} onSave={onSave} />)
  await act(async () => {})
  const input = screen.getByRole('textbox') as HTMLTextAreaElement
  expect(input.readOnly).toBe(true)
  fireEvent.keyDown(input, { key: 's', metaKey: true })
  expect(onSave).not.toHaveBeenCalled()
  view.rerender(<MonacoDiffEditor original="saved" modified="unsaved" />)
  await act(async () => {})
  expect((screen.getByRole('textbox', { name: 'Saved version (basic comparison)' }) as HTMLTextAreaElement).value).toBe('saved')
  expect((screen.getByRole('textbox', { name: 'Your draft (basic comparison)' }) as HTMLTextAreaElement).value).toBe('unsaved')
})

it('cleans up its timer without cancelling another editor’s shared initialization', async () => {
  let resolve!: () => void
  const cancel = vi.fn()
  mocked.init.mockReturnValue(Object.assign(new Promise<void>(done => { resolve = done }), { cancel }))
  const view = render(<MonacoEditor value="source" />)
  view.unmount()
  expect(vi.getTimerCount()).toBe(0)
  await act(async () => resolve())
  expect(cancel).not.toHaveBeenCalled()
})
