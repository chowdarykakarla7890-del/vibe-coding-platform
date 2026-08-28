import { createSandboxStore, emptyWorkspace, mapDataToState, useSandboxStore, workspaceSnapshot, type SandboxStateStore } from '@/app/state'
import type { ChatUIMessage } from '@/components/chat/types'
import type { DataPart } from '@/ai/messages/data-parts'
import type { DataUIPart } from 'ai'

type Project = { id: string; sandboxId?: string }
interface Entry {
  store: SandboxStateStore
  registeredSandboxId?: string
  retired: Set<string>
  seen: Map<string, string>
}

/** Account-lifetime projections, not authorization or durable source storage.
 * Only the active projection is exposed through the existing UI store. Hidden
 * streams update their own entry; log cursors survive navigation/remounts.
 */
export class ProjectWorkspaceRegistry {
  private entries = new Map<string, Entry>()
  private activeId?: string
  private connected = false
  private publishing = false

  constructor(private visible: SandboxStateStore = useSandboxStore) {}

  connect(signal: AbortSignal) {
    this.connected = !signal.aborted
    const unsubscribe = this.visible.subscribe(state => {
      if (!this.connected || this.publishing || state.projectId !== this.activeId) return
      const entry = this.activeId ? this.entries.get(this.activeId) : undefined
      if (!entry) return
      this.retirePrevious(entry, state.sandboxId)
      entry.store.getState().replaceWorkspace(workspaceSnapshot(state))
    })
    const dispose = () => {
      unsubscribe()
      signal.removeEventListener('abort', dispose)
      this.connected = false
      this.activeId = undefined
      this.entries.clear()
      this.visible.getState().clearSandbox()
    }
    signal.addEventListener('abort', dispose, { once: true })
    if (signal.aborted) dispose()
    return dispose
  }

  private retirePrevious(entry: Entry, nextId?: string) {
    const previous = entry.store.getState().sandboxId
    if (previous && previous !== nextId) entry.retired.add(previous)
  }

  private sync(project: Project) {
    let entry = this.entries.get(project.id)
    if (!entry) {
      entry = { store: createSandboxStore(), retired: new Set(), seen: new Map(), registeredSandboxId: project.sandboxId }
      entry.store.getState().replaceWorkspace(emptyWorkspace(project.id))
      if (project.sandboxId) entry.store.getState().setSandboxId(project.sandboxId)
      this.entries.set(project.id, entry)
    } else if (entry.registeredSandboxId !== project.sandboxId) {
      entry.registeredSandboxId = project.sandboxId
      // A delayed project receipt must not put a retired VM back in service.
      if (!project.sandboxId || !entry.retired.has(project.sandboxId)) {
        this.retirePrevious(entry, project.sandboxId)
        if (project.sandboxId) entry.store.getState().setSandboxId(project.sandboxId)
        else entry.store.getState().replaceWorkspace(emptyWorkspace(project.id))
      }
    }
    return entry
  }

  syncProjects(projects: Project[]) {
    if (!this.connected) return
    const valid = new Set(projects.map(project => project.id))
    for (const id of this.entries.keys()) if (!valid.has(id)) this.entries.delete(id)
    for (const project of projects) if (this.entries.has(project.id)) this.sync(project)
    if (this.activeId && !valid.has(this.activeId)) this.activate(undefined)
    else this.publish()
  }

  activate(project?: Project) {
    if (!this.connected) return
    if (project) this.sync(project)
    this.activeId = project?.id
    this.publish()
  }

  private publish() {
    if (!this.connected) return
    const state = this.activeId ? this.entries.get(this.activeId)?.store.getState() : undefined
    const snapshot = state ? workspaceSnapshot(state) : emptyWorkspace()
    const current = this.visible.getState()
    if ((Object.keys(snapshot) as (keyof typeof snapshot)[]).every(key => Object.is(snapshot[key], current[key]))) return
    this.publishing = true
    try { current.replaceWorkspace(snapshot) }
    finally { this.publishing = false }
  }

  apply(projectId: string, part: DataUIPart<DataPart>, fromHistory = false) {
    const entry = this.entries.get(projectId)
    if (!this.connected || !entry) return
    // Never attach a VM or recreate deleted source paths from old chat history.
    // Owned project/source APIs remain authoritative after a reload.
    if (fromHistory && part.type !== 'data-run-command' && part.type !== 'data-get-sandbox-url') return
    const sandboxId = 'sandboxId' in part.data ? part.data.sandboxId : undefined
    if (sandboxId && entry.retired.has(sandboxId)) return
    if (part.type !== 'data-create-sandbox' && sandboxId !== entry.store.getState().sandboxId) return
    const key = part.id ? `${part.type}:${part.id}` : undefined
    const signature = key ? JSON.stringify(part.data) : undefined
    if (key && entry.seen.get(key) === signature) return
    if (key && signature) entry.seen.set(key, signature)
    if (part.type === 'data-create-sandbox' && part.data.status === 'done' && sandboxId) this.retirePrevious(entry, sandboxId)
    mapDataToState(part, entry.store)
    if (this.activeId === projectId) this.publish()
  }

  reconcileMessages(projectId: string, messages: ChatUIMessage[]) {
    for (const message of messages) {
      if (message.role !== 'assistant') continue
      for (const part of message.parts) {
        if (part.type === 'data-run-command' || part.type === 'data-get-sandbox-url') this.apply(projectId, part, true)
      }
    }
  }
}
