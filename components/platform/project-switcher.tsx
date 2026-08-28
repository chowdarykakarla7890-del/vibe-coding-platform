'use client'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useLearning } from '@/lib/learning/learning-provider'
import {
  ChevronDownIcon,
  ArchiveIcon,
  DownloadIcon,
  FolderGit2Icon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  UploadIcon,
} from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useId, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useSandboxStore } from '@/app/state'
import { ProjectArchiveExport } from './project-archive-export'
import { ProjectSourceImport } from './project-source-import'
import dynamic from 'next/dynamic'
import { requestProjectNavigationFocus } from '@/lib/client/project-navigation-focus'

const ProjectArchiveImport = dynamic(() => import('./project-archive-import').then(module => module.ProjectArchiveImport))
const ProjectImportedHistory = dynamic(() => import('./project-imported-history').then(module => module.ProjectImportedHistory))
const ProjectLegacyRecovery = dynamic(() => import('./project-legacy-recovery').then(module => module.ProjectLegacyRecovery))

function routeForProject(mode: string, activityId?: string) {
  if (mode === 'playground' || !activityId) return '/playground'
  const base = mode === 'challenge' ? 'challenges' : mode === 'project' ? 'projects' : mode
  return `/${base}/${activityId}`
}

function withTutorSettings(path: string) {
  const current = new URLSearchParams(window.location.search)
  const preserved = new URLSearchParams()
  for (const key of ['modelId', 'effort', 'fix-errors']) {
    const value = current.get(key)
    if (value !== null) preserved.set(key, value)
  }
  const query = preserved.toString()
  return query ? `${path}?${query}` : path
}

export function ProjectSwitcher() {
  const { activeProject, createProject, deleteProject, exportProject, openImportedProject, projects, selectProject, updateProject } = useLearning()
  const [open, setOpen] = useState(false)
  const [action, setAction] = useState<'create' | 'rename' | 'delete' | null>(null)
  const [projectName, setProjectName] = useState('')
  const [busy, setBusy] = useState(false)
  const [archiveProject, setArchiveProject] = useState<{ id: string; title: string } | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [archiveImportOpen, setArchiveImportOpen] = useState(false)
  const [legacyRecoveryOpen, setLegacyRecoveryOpen] = useState(false)
  const [deviceArchive, setDeviceArchive] = useState<File>()
  const [historyProject, setHistoryProject] = useState<string | null>(null)
  const busyRef = useRef(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const nameId = useId()
  const router = useRouter()
  const dirtyFilePath = useSandboxStore((state) => state.dirtyFilePath)
  const setDirtyFilePath = useSandboxStore((state) => state.setDirtyFilePath)
  if (archiveProject && archiveProject.id !== activeProject?.id) setArchiveProject(null)
  if (historyProject && historyProject !== activeProject?.id) setHistoryProject(null)

  async function perform(operation: () => Promise<void>) {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try { await operation() }
    catch (error) { toast.error(error instanceof Error ? error.message : 'The project operation failed. Please retry.') }
    finally { busyRef.current = false; setBusy(false) }
  }

  function confirmDiscardDraft() {
    if (!dirtyFilePath) return true
    const confirmed = window.confirm(
      `Discard unsaved changes in ${dirtyFilePath}?`
    )
    if (confirmed) setDirtyFilePath(undefined)
    return confirmed
  }

  async function create() {
    if (!projectName.trim()) return
    if (!confirmDiscardDraft()) return
    const project = await createProject({ title: projectName.trim() })
    router.push(withTutorSettings('/playground'))
    setAction(null)
    requestProjectNavigationFocus(project.id)
    toast.success(`Created ${project.title}`)
  }

  async function rename() {
    if (!activeProject) return
    if (!projectName.trim()) return
    await updateProject(activeProject.id, { title: projectName.trim() })
    setAction(null)
  }

  async function download() {
    if (!activeProject) return
    const data = await exportProject(activeProject.id)
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    const fileName =
      activeProject.title
        .replace(/[^a-z0-9]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase() || 'project'
    link.download = `${fileName}.codetutor.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  async function remove() {
    if (!activeProject) return
    if (!confirmDiscardDraft()) return
    await deleteProject(activeProject.id)
    setAction(null)
    setOpen(false)
    toast.success('Project deleted')
  }

  return (
    <>
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button ref={triggerRef} data-project-switcher-id={activeProject?.id} className="h-8 min-w-0 max-w-[240px] shrink gap-2 font-mono text-xs" variant="outline">
          <FolderGit2Icon className="size-3.5 shrink-0" />
          <span className="truncate">{activeProject?.title ?? 'Choose a project'}</span>
          <ChevronDownIcon className="size-3 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        aria-label="Projects"
        aria-hidden={open ? undefined : true}
        inert={!open}
        align="start"
        onCloseAutoFocus={event => {
          // The newly opened dialog owns focus; a closing popover must not
          // move it back behind that modal after its input has autofocus.
          if (action || archiveProject || importOpen || archiveImportOpen || legacyRecoveryOpen || historyProject) event.preventDefault()
        }}
        className="max-h-[var(--radix-popover-content-available-height)] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto p-2"
      >
        <div className="max-h-56 space-y-1 overflow-y-auto">
          {projects.length ? projects.map((project) => (
            <button
              className="flex w-full items-center rounded-md px-3 py-2 text-left text-sm hover:bg-secondary"
              key={project.id}
              aria-current={project.id === activeProject?.id ? 'true' : undefined}
              aria-label={`${project.title} (${project.mode})`}
              onClick={() => {
                if (project.id !== activeProject?.id && !confirmDiscardDraft()) {
                  return
                }
                selectProject(project.id)
                router.push(withTutorSettings(routeForProject(project.mode, project.activityId)))
                setOpen(false)
                requestProjectNavigationFocus(project.id)
              }}
              type="button"
            >
              <span className="min-w-0 flex-1 truncate">{project.title}</span>
              <span className="ml-2 font-mono text-[10px] uppercase text-muted-foreground">{project.mode}</span>
            </button>
          )) : <p className="px-3 py-4 text-sm text-muted-foreground">No saved projects yet.</p>}
        </div>
        <div className="mt-2 grid grid-cols-2 gap-1 border-t border-border pt-2">
          <Button className="justify-start" onClick={() => { setOpen(false); setProjectName('Untitled playground'); setAction('create') }} size="sm" variant="ghost"><PlusIcon className="size-3.5" />New</Button>
          <Button className="justify-start" disabled={!activeProject} onClick={() => { setOpen(false); setProjectName(activeProject?.title ?? ''); setAction('rename') }} size="sm" variant="ghost"><PencilIcon className="size-3.5" />Rename</Button>
          <Button className="justify-start" disabled={!activeProject || busy} onClick={() => void perform(download)} size="sm" variant="ghost"><DownloadIcon className="size-3.5" />Source export</Button>
          <Button className="justify-start" onClick={() => { setOpen(false); setImportOpen(true) }} size="sm" variant="ghost"><UploadIcon className="size-3.5" />Import source</Button>
          <Button className="justify-start" onClick={() => { setOpen(false); setArchiveImportOpen(true) }} size="sm" variant="ghost"><UploadIcon className="size-3.5" />Import archive</Button>
          <Button className="justify-start" disabled={!activeProject} onClick={() => { if (activeProject) { setOpen(false); setHistoryProject(activeProject.id) } }} size="sm" variant="ghost"><ArchiveIcon className="size-3.5" />Imported history</Button>
          <Button className="col-span-2 justify-start" disabled={!activeProject} size="sm" variant="ghost" onClick={() => { if (activeProject) { setOpen(false); setArchiveProject({ id: activeProject.id, title: activeProject.title }) } }}><ArchiveIcon className="size-3.5" />Full project archive</Button>
          <Button className="col-span-2 justify-start" size="sm" variant="ghost" onClick={() => { setOpen(false); setLegacyRecoveryOpen(true) }}><UploadIcon className="size-3.5" />Recover device projects</Button>
          <Button className="col-span-2 justify-start text-destructive hover:text-destructive" disabled={!activeProject} onClick={() => { setOpen(false); setAction('delete') }} size="sm" variant="ghost"><Trash2Icon className="size-3.5" />Delete project</Button>
        </div>
      </PopoverContent>
    </Popover>
    {archiveProject ? <ProjectArchiveExport key={archiveProject.id} projectId={archiveProject.id} title={archiveProject.title} onClose={() => setArchiveProject(null)} /> : null}
    {importOpen ? <ProjectSourceImport onClose={() => setImportOpen(false)} onOpen={project => { openImportedProject(project); router.push(withTutorSettings('/playground')); toast.success('Imported source is ready') }} /> : null}
    {archiveImportOpen ? <ProjectArchiveImport initialFile={deviceArchive} onClose={() => { setArchiveImportOpen(false); setDeviceArchive(undefined) }} onOpen={project => { openImportedProject(project); router.push(withTutorSettings('/playground')); toast.success('Archived source and history recovered') }} /> : null}
    {legacyRecoveryOpen ? <ProjectLegacyRecovery onClose={() => setLegacyRecoveryOpen(false)} onContinue={file => { setDeviceArchive(file); setLegacyRecoveryOpen(false); setArchiveImportOpen(true) }} /> : null}
    {historyProject ? <ProjectImportedHistory key={historyProject} projectId={historyProject} onClose={() => setHistoryProject(null)} /> : null}
    <Dialog onOpenChange={(next) => { if (!next && !busy) setAction(null) }} open={action !== null}>
      <DialogContent onCloseAutoFocus={event => { event.preventDefault(); triggerRef.current?.focus() }}>
        <DialogHeader>
          <DialogTitle>{action === 'create' ? 'Create project' : action === 'rename' ? 'Rename project' : 'Delete project?'}</DialogTitle>
          <DialogDescription>{action === 'delete' ? `This permanently removes “${activeProject?.title ?? 'this project'}” and its saved cloud source snapshots. Any registered active sandbox will be stopped.` : 'Projects are saved to your account. You can change the name later.'}</DialogDescription>
        </DialogHeader>
        {action !== 'delete' ? (
          <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void perform(action === 'create' ? create : rename) }}>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor={nameId}>Project name</label>
              <Input autoFocus id={nameId} maxLength={80} onChange={(event) => setProjectName(event.target.value)} value={projectName} />
            </div>
            <DialogFooter><Button disabled={busy} onClick={() => setAction(null)} type="button" variant="outline">Cancel</Button><Button disabled={busy || !projectName.trim()} type="submit">{busy ? 'Saving…' : action === 'create' ? 'Create project' : 'Save name'}</Button></DialogFooter>
          </form>
        ) : (
          <DialogFooter><Button disabled={busy} onClick={() => setAction(null)} variant="outline">Cancel</Button><Button disabled={busy} onClick={() => void perform(remove)} variant="destructive">{busy ? 'Deleting…' : 'Delete project'}</Button></DialogFooter>
        )}
      </DialogContent>
    </Dialog>
    </>
  )
}
