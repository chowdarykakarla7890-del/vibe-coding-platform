import type { Command, CommandLog } from '@/components/commands-logs/types'
import type { DataPart } from '@/ai/messages/data-parts'
import type { ChatStatus, DataUIPart } from 'ai'
import { create } from 'zustand'
import { appendCommandLog } from '@/lib/commands/log-state'

interface SandboxStore {
  sourceUpdate?: { path: string; revision: number; deleted: boolean; sequence: number }
  notifySourceApplied: (sandboxId: string, file: { path: string; revision: number; deleted: boolean }) => void
  activeFile?: string
  addLog: (data: { sandboxId: string; cmdId: string; log: CommandLog; cursor?: string }) => void
  addPaths: (paths: string[]) => void
  chatStatus: ChatStatus
  clearSandbox: () => void
  commands: Command[]
  dirtyFilePath?: string
  paths: string[]
  sandboxId?: string
  setChatStatus: (status: ChatStatus) => void
  setDirtyFilePath: (path?: string) => void
  setActiveFile: (path?: string) => void
  setSandboxId: (id: string) => void
  setSandboxStatus: (sandboxId: string, status: 'running' | 'stopping' | 'stopped') => void
  setUrl: (url: string, uuid: string) => void
  recordStudentEdit: () => void
  status?: 'running' | 'stopping' | 'stopped'
  studentEdits: number
  upsertCommand: (command: Omit<Command, 'startedAt'>) => void
  url?: string
  urlUUID?: string
}

export const useSandboxStore = create<SandboxStore>()((set) => ({
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
  clearSandbox: () =>
    set(() => ({
      sandboxId: undefined,
      sourceUpdate: undefined,
      status: undefined,
      commands: [],
      dirtyFilePath: undefined,
      activeFile: undefined,
      paths: [],
      url: undefined,
      urlUUID: undefined,
      studentEdits: 0,
    })),
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
      cmds[idx] = { ...prev, ...cmd }
      return { commands: cmds }
    })
  },
}))

export function mapDataToState(data: DataUIPart<DataPart>) {
  const {
    addPaths,
    setSandboxId,
    setUrl,
    upsertCommand,
  } = useSandboxStore.getState()

    switch (data.type) {
      case 'data-create-sandbox':
        if (data.data.sandboxId) {
          setSandboxId(data.data.sandboxId)
        }
        break
      case 'data-generating-files':
        if (data.data.sandboxId !== useSandboxStore.getState().sandboxId) break
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
        if (data.data.url) {
          setUrl(data.data.url, crypto.randomUUID())
        }
        break
      default:
        break
    }
}
