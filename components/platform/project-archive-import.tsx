'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useSandboxStore } from '@/app/state'
import { acknowledgeArchiveImport, cancelPendingArchiveImport, checkPendingArchiveImport, importProjectArchive, type ArchiveImportProgress } from '@/lib/learning/archive-import'
import type { ArchiveImportReceipt } from '@/lib/projects/archive-import'
import type { LearningProject } from '@/lib/learning/types'

export function ProjectArchiveImport({ onClose, onOpen, initialFile, onReturnFocus }: { onClose: () => void; onOpen: (project: LearningProject) => void; initialFile?: File; onReturnFocus?: () => void }) {
  const [busy, setBusy] = useState(true), [error, setError] = useState<string>()
  const [receipt, setReceipt] = useState<ArchiveImportReceipt>(), [project, setProject] = useState<LearningProject>()
  const [file, setFile] = useState<File | undefined>(initialFile), [paused, setPaused] = useState(false)
  const [progress, setProgress] = useState<ArchiveImportProgress>()
  const mounted = useRef(false), task = useRef<AbortController | null>(null)
  const dirty = useSandboxStore(state => state.dirtyFilePath)
  useEffect(() => {
    mounted.current = true
    const controller = new AbortController()
    task.current = controller
    void checkPendingArchiveImport(controller.signal).then(value => {
      if (mounted.current && !controller.signal.aborted) { setReceipt(value); setProject(value?.project ?? undefined) }
    }).catch(cause => {
      if (mounted.current && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not check the pending archive.')
    }).finally(() => {
      if (task.current === controller) {
        task.current = null
        if (mounted.current) { setBusy(false); if (controller.signal.aborted) setPaused(true) }
      }
    })
    return () => { mounted.current = false; controller.abort(); task.current?.abort() }
  }, [])

  async function run(cancel = false) {
    if (task.current || (!file && !cancel)) return
    const controller = new AbortController()
    task.current = controller
    setBusy(true); setPaused(false); setError(undefined); setProgress(undefined)
    try {
      if (cancel) {
        const value = await cancelPendingArchiveImport(controller.signal)
        if (!mounted.current || controller.signal.aborted) return
        setReceipt(value); setProject(value?.project ?? undefined)
        if (value?.state !== 'published') setFile(undefined)
      } else {
        const saved = await importProjectArchive(file!, controller.signal, value => {
          if (mounted.current && !controller.signal.aborted) {
            setProgress(value)
            if (value.phase === 'uploading') setReceipt(value.receipt)
          }
        })
        if (!mounted.current || controller.signal.aborted) return
        setProject(saved)
      }
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Archive recovery could not be confirmed. Retry with the original file.')
    } finally {
      if (task.current === controller) task.current = null
      if (mounted.current) { setBusy(false); if (controller.signal.aborted) setPaused(true) }
    }
  }
  function openProject() {
    if (!project || busy) return
    if (dirty && !window.confirm(`Discard unsaved changes in ${dirty} and open the imported project?`)) return
    if (dirty) useSandboxStore.getState().setDirtyFilePath(undefined)
    onOpen(project); acknowledgeArchiveImport(project.id); onClose()
  }
  const status = project ? 'Saved source and all archived records are recovered. Open the new project when ready.'
    : busy ? progress?.phase === 'validating' ? `Checking archive integrity: ${progress.records} records…`
      : progress?.phase === 'uploading' && progress.waitingSeconds ? `Request limit reached. Continuing in ${progress.waitingSeconds} seconds…`
      : receipt ? `Uploading: ${receipt.uploadedRecords} of ${receipt.manifest.recordCount} records verified…` : 'Checking the import…'
    : paused ? 'Import paused. Choose the original archive to resume, or cancel its staged upload.'
      : receipt?.state === 'uploading' ? `Pending: ${receipt.uploadedRecords} of ${receipt.manifest.recordCount} records. Choose the original archive to resume.`
      : receipt?.state === 'cancelled' ? 'Staged archive cancelled. No project was removed.'
      : 'The archive is checked before upload. Your new project appears only after every record is verified.'
  return <Dialog open onOpenChange={open => { if (!open) { task.current?.abort(); onClose() } }}>
    <DialogContent aria-busy={busy} onCloseAutoFocus={event => { if (onReturnFocus) { event.preventDefault(); onReturnFocus() } }}>
      <DialogHeader><DialogTitle>Import full project archive</DialogTitle><DialogDescription>Recover a CodeTutor NDJSON archive to your signed-in account. Existing projects and the original file stay unchanged.</DialogDescription></DialogHeader>
      <p className="text-sm text-muted-foreground">Saved source opens in a new, ungraded Playground. Chat, submissions, scores and other history are preserved in Imported history as read-only, unverified evidence. They do not replay tools, restore a running sandbox, or count toward verified progress.</p>
      {!project ? <label className="space-y-2 text-sm"><span>Full project archive (.ndjson)</span><input aria-label="Full project archive" className="block w-full rounded border border-border p-2" type="file" accept=".ndjson,application/x-ndjson" disabled={busy} onChange={event => { setFile(event.target.files?.[0]); setError(undefined) }} /></label> : null}
      {!project && file ? <p className="break-words text-sm">Selected backup: {file.name}</p> : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <p role="status" aria-live="polite" className="min-h-10 text-sm">{status}</p>
      <p className="text-xs text-muted-foreground">Up to 50,000 records / 256 MB of archived data; source is limited to 200 files / 10 MB. Pending uploads expire after two hours. Keep archives private: source and messages may contain sensitive information.</p>
      <DialogFooter className="flex-wrap">
        <Button variant="outline" onClick={() => busy ? task.current?.abort() : onClose()}>{busy ? 'Pause import' : 'Close'}</Button>
        {!project ? <Button variant="outline" disabled={busy} onClick={() => void run(true)}>Cancel staged archive</Button> : null}
        {project ? <Button onClick={openProject} disabled={busy}>Open imported project</Button> : <Button disabled={busy || !file} onClick={() => void run()}>{error || paused || receipt?.state === 'uploading' ? 'Retry / resume archive' : 'Import archive'}</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
