'use client'

import type { LearningProject, ProgressRecord } from './types'
import { Button } from '@/components/ui/button'
import { loadWorkspaceHistory } from './load-history'
import { cloudOperation } from './cloud-request'
import { readLocalPreference, writeLocalPreference } from '@/lib/local-preferences'
import {
  exportProject as createProjectExport,
  importProject as importProjectRecord,
  createProject as createProjectRecord,
  listProgress,
  removeProject,
  saveProject,
  type ProjectExport,
} from './db'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

interface NewProjectInput {
  title: string
  mode?: LearningProject['mode']
  activityId?: string
  language?: string
}

interface LearningContextValue {
  activeProject?: LearningProject
  activeProjectId?: string
  createProject: (input: NewProjectInput, signal?: AbortSignal) => Promise<LearningProject>
  deleteProject: (id: string) => Promise<void>
  exportProject: (id: string) => Promise<ProjectExport>
  importProject: (data: unknown) => Promise<LearningProject>
  openImportedProject: (project: LearningProject) => void
  isReady: boolean
  progress: ProgressRecord[]
  projects: LearningProject[]
  selectProject: (id: string) => void
  updateProject: (id: string, patch: Partial<LearningProject>, signal?: AbortSignal) => Promise<void>
  refreshProgress: () => Promise<void>
}

const LearningContext = createContext<LearningContextValue | null>(null)

export function LearningProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<LearningProject[]>([])
  const [progress, setProgress] = useState<ProgressRecord[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string>()
  const [isReady, setIsReady] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [loadVersion, setLoadVersion] = useState(0)
  const projectsRef = useRef<LearningProject[]>([])
  const activeProjectIdRef = useRef<string | undefined>(undefined)
  const projectUpdates = useRef(new Map<string, Promise<void>>())

  useEffect(() => {
    const controller = new AbortController()
    void loadWorkspaceHistory(controller.signal)
      .then(([nextProjects, nextProgress]) => {
        if (controller.signal.aborted) return
        projectsRef.current = nextProjects
        setProjects(nextProjects)
        setProgress(nextProgress)
        const savedId = readLocalPreference('codetutor-active-project')
        const nextActiveId = nextProjects.some((project) => project.id === savedId)
          ? savedId ?? undefined
          : nextProjects[0]?.id
        setActiveProjectId(nextActiveId)
        activeProjectIdRef.current = nextActiveId
        writeLocalPreference('codetutor-active-project', nextActiveId ?? null)
        setIsReady(true)
      })
      .catch((error) => {
        if (controller.signal.aborted) return
        console.warn('Could not load local learning history', {
          errorName: error instanceof Error ? error.name : 'StorageError',
        })
        // Do not interpret an unavailable database as an empty account. In
        // particular, do not mount consumers that auto-create a new project.
        setLoadError(true)
      })
    return () => {
      controller.abort()
    }
  }, [loadVersion])

  const selectProject = useCallback((id: string) => {
    activeProjectIdRef.current = id
    setActiveProjectId(id)
    writeLocalPreference('codetutor-active-project', id)
  }, [])

  const createProject = useCallback(async (input: NewProjectInput, signal?: AbortSignal) => {
    const origin = cloudOperation(signal)
    const now = Date.now()
    const project: LearningProject = {
      id: crypto.randomUUID(),
      title: input.title.trim() || 'Untitled project',
      mode: input.mode ?? 'playground',
      activityId: input.activityId,
      language: input.language ?? 'Any',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    }
    const saved = await createProjectRecord(project, origin.signal)
    origin.assertActive()
    const nextProjects = [saved, ...projectsRef.current]
    projectsRef.current = nextProjects
    setProjects(nextProjects)
    selectProject(project.id)
    return saved
  }, [selectProject])

  const updateProject = useCallback(async (id: string, patch: Partial<LearningProject>, signal?: AbortSignal) => {
    const origin = cloudOperation(signal)
    // Serialize per-project writes and publish only durable changes. In
    // particular, a failed restore must leave the old sandbox attached.
    const operation = (projectUpdates.current.get(id) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        origin.assertActive()
        const existing = projectsRef.current.find((project) => project.id === id)
        if (!existing) throw new Error('This project no longer exists.')
        const updated: LearningProject = {
          ...existing,
          ...patch,
          id,
          updatedAt: Date.now(),
        }
        const saved = await saveProject(updated, origin.signal)
        origin.assertActive()
        const nextProjects = projectsRef.current.map((project) =>
          project.id === id ? saved : project
        )
        projectsRef.current = nextProjects
        setProjects(nextProjects)
      })
    projectUpdates.current.set(id, operation)
    void operation.finally(() => {
      if (projectUpdates.current.get(id) === operation) projectUpdates.current.delete(id)
    }).catch(() => undefined)
    return operation
  }, [])

  const deleteProject = useCallback(async (id: string) => {
    // Confirmed project deletion already stops its VMs on the server. A second
    // browser Stop raced that deletion and could start a capture for data the
    // user explicitly chose to delete (or run under a changed account).
    await removeProject(id)
    const next = projectsRef.current.filter((item) => item.id !== id)
    projectsRef.current = next
    setProjects(next)
    if (activeProjectIdRef.current === id) {
      const nextId = next[0]?.id
      activeProjectIdRef.current = nextId
      setActiveProjectId(nextId)
      writeLocalPreference('codetutor-active-project', nextId ?? null)
    }
  }, [])

  const exportProject = useCallback(async (id: string) => {
    const project = projects.find((item) => item.id === id)
    if (!project) throw new Error('Project not found')
    return createProjectExport(project)
  }, [projects])

  const openImportedProject = useCallback((project: LearningProject) => {
    const nextProjects = [project, ...projectsRef.current.filter(item => item.id !== project.id)]
    projectsRef.current = nextProjects
    setProjects(nextProjects)
    selectProject(project.id)
  }, [selectProject])
  const importProject = useCallback(async (data: unknown) => {
    const project = await importProjectRecord(data)
    openImportedProject(project)
    return project
  }, [openImportedProject])

  const refreshProgress = useCallback(async () => setProgress(await listProgress()), [])

  const activeProject = projects.find((project) => project.id === activeProjectId)
  const value = useMemo(
    () => ({
      activeProject,
      activeProjectId,
      createProject,
      deleteProject,
      exportProject,
      importProject,
      openImportedProject,
      isReady,
      progress,
      projects,
      refreshProgress,
      selectProject,
      updateProject,
    }),
    [
      activeProject,
      activeProjectId,
      createProject,
      deleteProject,
      exportProject,
      importProject,
      openImportedProject,
      isReady,
      progress,
      projects,
      refreshProgress,
      selectProject,
      updateProject,
    ]
  )

  if (!isReady) {
    return <main className="grid h-dvh place-items-center bg-background p-6">
      <section className="max-w-md text-center" aria-live="polite">
        {loadError ? <>
          <h1 className="text-xl font-semibold">Saved work could not be opened</h1>
          <p className="mt-3 text-sm text-muted-foreground">Check your connection and sign-in, and allow browser storage for this site. No saved projects or source snapshots have been changed. Do not clear site data to fix this.</p>
          <Button className="mt-5" onClick={() => { setLoadError(false); setLoadVersion((version) => version + 1) }}>Retry loading saved work</Button>
        </> : <p role="status" className="text-sm text-muted-foreground">Opening saved projects…</p>}
      </section>
    </main>
  }
  return <LearningContext.Provider value={value}>{children}</LearningContext.Provider>
}

export function useLearning() {
  const context = useContext(LearningContext)
  if (!context) throw new Error('useLearning must be used within LearningProvider')
  return context
}
