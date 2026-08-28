import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createSandboxStore } from '@/app/state'
import { ProjectWorkspaceRegistry } from '@/lib/workspace/project-registry'
import type { ChatUIMessage } from '@/components/chat/types'
import type { DataUIPart } from 'ai'
import type { DataPart } from '@/ai/messages/data-parts'

let visible: ReturnType<typeof createSandboxStore>
let registry: ProjectWorkspaceRegistry
let account: AbortController
let dispose: () => void
const a = { id: 'a', sandboxId: 'sandbox-a' }, b = { id: 'b', sandboxId: 'sandbox-b' }
const command = (sandboxId = a.sandboxId): DataUIPart<DataPart> => ({ id: 'run-a', type: 'data-run-command', data: { sandboxId, commandId: 'cmd-a', command: 'node', args: ['a.ts'], status: 'running' } })
const preview = (sandboxId?: string): DataUIPart<DataPart> => ({ id: `preview-${sandboxId}`, type: 'data-get-sandbox-url', data: { sandboxId, url: 'https://a.vercel.run', status: 'done' } })
const create = (sandboxId: string): DataUIPart<DataPart> => ({ id: `create-${sandboxId}`, type: 'data-create-sandbox', data: { sandboxId, status: 'done' } })
beforeEach(() => {
  visible = createSandboxStore(); registry = new ProjectWorkspaceRegistry(visible); account = new AbortController()
  dispose = registry.connect(account.signal); registry.activate(a)
})
afterEach(() => { dispose(); vi.restoreAllMocks() })

it('retains the complete projection while visible actions continue to target only the visible store', () => {
  const actions = visible.getState()
  actions.addPaths(['a.ts']); actions.setActiveFile('a.ts'); actions.setDirtyFilePath('a.ts'); actions.setWorkspaceTab('preview')
  actions.recordStudentEdit(); actions.notifySourceApplied(a.sandboxId, { path: 'a.ts', revision: 2, deleted: false })
  registry.apply('a', command()); registry.apply('a', preview(a.sandboxId))
  actions.addLog({ sandboxId: a.sandboxId, cmdId: 'cmd-a', cursor: 'v3.3.0', log: { stream: 'stdout', data: 'one', timestamp: 1 } })
  registry.activate(b)
  expect(visible.getState()).toMatchObject({ projectId: 'b', commands: [], paths: [], activeFile: undefined, workspaceTab: 'code' })
  actions.addPaths(['b.ts'])
  registry.activate(a)
  expect(visible.getState()).toMatchObject({ projectId: 'a', paths: ['a.ts'], activeFile: 'a.ts', dirtyFilePath: 'a.ts', studentEdits: 1, workspaceTab: 'preview',
    sourceUpdate: { revision: 2, sequence: 1 }, commands: [{ cmdId: 'cmd-a', logCursor: 'v3.3.0', logs: [{ data: 'one' }] }] })
  actions.addPaths(['second.ts'])
  registry.activate(b)
  expect(visible.getState().paths).toEqual(['b.ts'])
})

it('retains terminal status and rejects old VM tools or a delayed old project receipt after replacement', () => {
  registry.apply('a', command()); visible.getState().setSandboxStatus(a.sandboxId, 'stopped')
  registry.activate(b); registry.activate(a)
  expect(visible.getState().status).toBe('stopped')
  registry.syncProjects([{ id: 'a', sandboxId: 'replacement' }, b])
  registry.apply('a', create(a.sandboxId))
  registry.apply('a', command()); registry.apply('a', preview(a.sandboxId))
  registry.syncProjects([a, b])
  expect(visible.getState()).toMatchObject({ sandboxId: 'replacement', status: 'running', commands: [], paths: [], url: undefined })
})

it('ignores foreign and legacy preview updates instead of assigning them to whichever VM is visible', () => {
  registry.apply('a', preview(b.sandboxId)); registry.apply('a', preview())
  expect(visible.getState().url).toBeUndefined()
  registry.apply('a', preview(a.sandboxId))
  expect(visible.getState().url).toBe('https://a.vercel.run')
})

it('reconciles only current-VM assistant command/preview history without resurrecting files or sandboxes', () => {
  const messages = [{ id: 'old', role: 'assistant', parts: [create('old-vm'), command('old-vm'), preview('old-vm')] },
    { id: 'user', role: 'user', parts: [command()] },
    { id: 'current', role: 'assistant', parts: [create(a.sandboxId), command(), preview(a.sandboxId),
      { id: 'files', type: 'data-generating-files', data: { sandboxId: a.sandboxId, paths: ['deleted.ts'], status: 'done' } }] }] as ChatUIMessage[]
  registry.reconcileMessages('a', messages)
  expect(visible.getState()).toMatchObject({ sandboxId: a.sandboxId, paths: [], commands: [{ cmdId: 'cmd-a' }], url: 'https://a.vercel.run' })
  expect(visible.getState().commands).toHaveLength(1)
})

it('deduplicates history replay and does not regress a drained command or reset its cursor', () => {
  const part = command()
  registry.apply('a', part)
  visible.getState().addLog({ sandboxId: a.sandboxId, cmdId: 'cmd-a', cursor: 'v3.3.0', log: { stream: 'stdout', data: 'one', timestamp: 1 } })
  visible.getState().upsertCommand({ sandboxId: a.sandboxId, cmdId: 'cmd-a', command: 'node', args: ['a.ts'], status: 'done', exitCode: 0, logsComplete: true })
  const listener = vi.fn(), unsubscribe = visible.subscribe(listener)
  registry.reconcileMessages('a', [{ id: 'assistant', role: 'assistant', parts: [part] }])
  expect(listener).not.toHaveBeenCalled()
  registry.apply('a', { ...part, data: { ...part.data, status: 'waiting' } } as DataUIPart<DataPart>)
  expect(visible.getState().commands[0]).toMatchObject({ status: 'done', exitCode: 0, logsComplete: true, logCursor: 'v3.3.0', logs: [{ data: 'one' }] })
  unsubscribe()
})

it('forgets deleted projects and ignores their late callbacks', () => {
  registry.apply('a', command()); registry.activate(b); registry.syncProjects([b])
  registry.apply('a', create('late')); registry.apply('a', preview(a.sandboxId))
  registry.activate(a)
  expect(visible.getState()).toMatchObject({ commands: [], url: undefined })
})

it.each(['abort', 'unmount'] as const)('clears account projections on %s and denies late callbacks', reason => {
  registry.apply('a', command()); registry.activate(b)
  if (reason === 'abort') account.abort(); else dispose()
  registry.apply('a', create('late')); registry.activate(a)
  expect(visible.getState()).toMatchObject({ projectId: undefined, sandboxId: undefined, commands: [], url: undefined })
  dispose = registry.connect(new AbortController().signal); registry.activate(a)
  expect(visible.getState().commands).toEqual([])
})

it('keeps newly streamed VM state when the project refresh has not yet acknowledged its association', () => {
  registry.activate({ id: 'new' })
  registry.apply('new', create('created'))
  registry.syncProjects([{ id: 'new' }]); registry.activate({ id: 'new' })
  expect(visible.getState().sandboxId).toBe('created')
  registry.syncProjects([{ id: 'new', sandboxId: 'created' }])
  expect(visible.getState().sandboxId).toBe('created')
})
