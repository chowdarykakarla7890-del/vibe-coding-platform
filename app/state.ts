import type { Command, CommandLog } from '@/components/commands-logs/types'
import type { DataPart } from '@/ai/messages/data-parts'
import type { ChatStatus, DataUIPart } from 'ai'
import { create, type StateCreator } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { appendCommandLog } from '@/lib/commands/log-state'

export interface SandboxWorkspace {
  projectId?: string
  sourceUpdate?: { path: string; revision: number; deleted: boolean; sequence: number }
  activeFile?: string
  chatStatus: ChatStatus
  commands: Command[]
  dirtyFilePath?: string
  paths: string[]
  sandboxId?: string
  status?: 'running' | 'stopping' | 'stopped'
  studentEdits: number
  url?: string
  urlUUID?: string
  workspaceTab: 'code' | 'preview'
}

interface SandboxStore extends SandboxWorkspace {
  notifySourceApplied: (sandboxId: string, file: { path: string; revision: number; deleted: boolean }) => void
  addLog: (data: { sandboxId: string; cmdId: string; log: CommandLog; cursor?: string }) => void
  addPaths: (paths: string[]) => void
  clearSandbox: () => void
  replaceWorkspace: (workspace: SandboxWorkspace) => void
  setWorkspaceTab: (tab: SandboxWorkspace['workspaceTab']) => void
  setChatStatus: (status: ChatStatus) => void
  setDirtyFilePath: (path?: string) => void
  setActiveFile: (path?: string) => void
  setSandboxId: (id: string) => void
  setSandboxStatus: (sandboxId: string, status: 'running' | 'stopping' | 'stopped') => void
  setUrl: (url: string, uuid: string) => void
  recordStudentEdit: () => void
  upsertCommand: (command: Omit<Command, 'startedAt'>) => void
}

export function emptyWorkspace(projectId?: string): SandboxWorkspace {
  return { projectId, sourceUpdate: undefined, activeFile: undefined, chatStatus: 'ready', commands: [],
    dirtyFilePath: undefined, paths: [], sandboxId: undefined, status: undefined, studentEdits: 0, url: undefined, urlUUID: undefined, workspaceTab: 'code' }
}

/** Copy data only: copying actions would redirect writes to a hidden store. */
export function workspaceSnapshot(state: SandboxWorkspace): SandboxWorkspace {
  const { projectId, sourceUpdate, activeFile, chatStatus, commands, dirtyFilePath, paths, sandboxId, status, studentEdits, url, urlUUID, workspaceTab } = state
  return { projectId, sourceUpdate, activeFile, chatStatus, commands, dirtyFilePath, paths, sandboxId, status, studentEdits, url, urlUUID, workspaceTab }
}

const sandboxState: StateCreator<SandboxStore> = (set) => ({
  ...emptyWorkspace(),
  replaceWorkspace: (workspace) => set(workspaceSnapshot(workspace)),
  setWorkspaceTab: (workspaceTab) => set({ workspaceTab }),
  notifySourceApplied: (sandboxId, file) => set((state) => state.sandboxId !== sandboxId ? state : ({
    sourceUpdate: { ...file, sequence: (state.sourceUpdate?.sequence ?? 0) + 1 },
    paths: file.deleted ? state.paths.filter(path => path !== file.path) : [...new Set([...state.paths, file.path])],
  })),
  activeFile: undefined,
  addLog: (data) => {
    set((state) => {
      if (state.sandboxId !== data.sandboxId || state.status === 'stopped') return state
      const idx = state.commands.findIndex((c) => c.cmdId === data.cmdId)
      if (idx === -1) {
        console.warn(`Command with ID ${data.cmdId} not found.`)
        return state
      }
      const updatedCmds = [...state.commands]
      updatedCmds[idx] = appendCommandLog(updatedCmds[idx], data.log, data.cursor)
      if (updatedCmds[idx] === state.commands[idx]) return state
      return { commands: updatedCmds }
    })
  },
  addPaths: (paths) =>
    set((state) => {
      const nextPaths = [...new Set([...state.paths, ...paths])]
      return nextPaths.length === state.paths.length ? state : { paths: nextPaths }
    }),
  chatStatus: 'ready',
  clearSandbox: () => set(emptyWorkspace()),
  commands: [],
  paths: [],
  studentEdits: 0,
  recordStudentEdit: () =>
    set((state) => ({ studentEdits: state.studentEdits + 1 })),
  setChatStatus: (status) =>
    set((state) =>
      state.chatStatus === status ? state : { chatStatus: status }
    ),
  setDirtyFilePath: (dirtyFilePath) => set({ dirtyFilePath }),
  setActiveFile: (activeFile) => set({ activeFile }),
  setSandboxId: (sandboxId) =>
    set((state) => state.sandboxId === sandboxId ? state : ({
      sandboxId,
      sourceUpdate: undefined,
      status: 'running',
      commands: [],
      dirtyFilePath: undefined,
      activeFile: undefined,
      paths: [],
      url: undefined,
      urlUUID: undefined,
      studentEdits: 0,
      workspaceTab: 'code',
    })),
  setSandboxStatus: (sandboxId, status) => set((state) =>
    // A VM cannot resume after shutdown starts. Polls and shutdown receipts
    // can arrive out of order; only attaching a new ID may reopen execution.
    state.sandboxId !== sandboxId || state.status === status || state.status === 'stopped'
      || (state.status === 'stopping' && status === 'running') ? state : status === 'stopped' ? {
      status,
      url: undefined,
      urlUUID: undefined,
      commands: state.commands.map((command) => command.status === 'running'
        ? { ...command, status: 'error' as const, error: 'This sandbox is no longer running. Restore the workspace before running commands.' }
        : command),
    } : status === 'stopping' ? { status, url: undefined, urlUUID: undefined } : { status }
  ),
  setUrl: (url, urlUUID) => set((state) => state.status === 'stopped' || state.status === 'stopping' ? state : { url, urlUUID }),
  upsertCommand: (cmd) => {
    set((state) => {
      if (state.sandboxId !== cmd.sandboxId || state.status === 'stopped') return state
      const existingIdx = state.commands.findIndex((c) => c.cmdId === cmd.cmdId)
      const idx = existingIdx !== -1 ? existingIdx : state.commands.length
      const prev = state.commands[idx] ?? { startedAt: Date.now(), logs: [] }
      const cmds = [...state.commands]
      // A late tool update cannot turn a process that already finished back
      // into a running command. Output/cursors are retained across updates.
      cmds[idx] = { ...prev, ...cmd, ...(prev.status && prev.status !== 'running' && cmd.status === 'running'
        ? { status: prev.status, exitCode: prev.exitCode, error: prev.error, background: prev.background } : {}) }
      return { commands: cmds }
    })
  },
})

export const useSandboxStore = create<SandboxStore>()(sandboxState)
export const createSandboxStore = () => createStore<SandboxStore>()(sandboxState)
export type SandboxStateStore = ReturnType<typeof createSandboxStore>

export function mapDataToState(data: DataUIPart<DataPart>, store: SandboxStateStore = useSandboxStore) {
  const {
    addPaths,
    setSandboxId,
    setUrl,
    upsertCommand,
  } = store.getState()

    switch (data.type) {
      case 'data-create-sandbox':
        if (data.data.status === 'done' && data.data.sandboxId) {
          setSandboxId(data.data.sandboxId)
        }
        break
      case 'data-generating-files':
        if (data.data.sandboxId !== store.getState().sandboxId) break
        if (data.data.status === 'uploaded' || data.data.status === 'done') {
          addPaths(data.data.paths)
        }
        break
      case 'data-run-command':
        if (data.data.commandId) {
          upsertCommand({
            background: data.data.status === 'running',
            sandboxId: data.data.sandboxId,
            cmdId: data.data.commandId,
            command: data.data.command,
            args: data.data.args,
            error: data.data.error?.message,
            exitCode: data.data.exitCode,
            status:
              data.data.status === 'done'
                ? 'done'
                : data.data.status === 'error'
                  ? 'error'
                  : 'running',
          })
        }
        break
      case 'data-get-sandbox-url':
        if (data.data.status === 'done' && data.data.sandboxId === store.getState().sandboxId && data.data.sandboxId && data.data.url) {
          setUrl(data.data.url, crypto.randomUUID())
        }
        break
      default:
        break
    }
}
