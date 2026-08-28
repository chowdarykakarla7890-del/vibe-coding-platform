'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useSandboxStore } from '@/app/state'
import { acknowledgeSourceImport, cancelPendingSourceImport, checkPendingSourceImport, importSourceProject } from '@/lib/learning/source-import'
import { MAX_SOURCE_IMPORT_FILE_BYTES, type SourceImportReceipt } from '@/lib/projects/source-import'
import { readWithDeadline } from '@/lib/abortable-read'
import type { LearningProject } from '@/lib/learning/types'

export function ProjectSourceImport({ onClose, onOpen }: { onClose: () => void; onOpen: (project: LearningProject) => void }) {
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string>()
  const [receipt, setReceipt] = useState<SourceImportReceipt>()
  const [project, setProject] = useState<LearningProject>()
  const [file, setFile] = useState<File>()
  const [paused, setPaused] = useState(false)
  const mounted = useRef(false)
  const task = useRef<AbortController | null>(null)
  const dirty = useSandboxStore(state => state.dirtyFilePath)

  useEffect(() => {
    mounted.current = true
    const controller = new AbortController()
    task.current = controller
    void checkPendingSourceImport(controller.signal).then(value => {
      if (mounted.current && !controller.signal.aborted) { setReceipt(value); setProject(value?.project ?? undefined) }
    }).catch(cause => {
      if (mounted.current && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not check the pending import.')
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
    setBusy(true); setPaused(false); setError(undefined)
    try {
      if (cancel) {
        const value = await cancelPendingSourceImport(controller.signal)
        if (!mounted.current || controller.signal.aborted) return
        setReceipt(value); setProject(value?.project ?? undefined)
        if (value?.state !== 'published') setFile(undefined)
      } else {
        if (file!.size > MAX_SOURCE_IMPORT_FILE_BYTES) throw new Error('This file exceeds the source-import limit. Use a source-only project JSON export, not a full history archive.')
        const text = await readWithDeadline(() => file!.text(), controller.signal, 15_000, 'The selected file could not be read. Choose it again.')
        let input: unknown
        try { input = JSON.parse(text) } catch { throw new Error('Choose a valid source-only CodeTutor JSON export. NDJSON full-history archives are not supported here.') }
        const saved = await importSourceProject(input, controller.signal, value => {
          if (mounted.current && !controller.signal.aborted) setReceipt(value)
        })
        if (!mounted.current || controller.signal.aborted) return
        setProject(saved)
      }
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'The import could not be confirmed. Retry with the same export file.')
    } finally {
      if (task.current === controller) task.current = null
      if (mounted.current) { setBusy(false); if (controller.signal.aborted) setPaused(true) }
    }
  }

  function openProject() {
    if (!project || busy) return
    // Keep the draft through parsing, upload, error, cancellation and success.
    // Only an explicit successful project switch may discard it.
    if (dirty && !window.confirm(`Discard unsaved changes in ${dirty} and open the imported project?`)) return
    if (dirty) useSandboxStore.getState().setDirtyFilePath(undefined)
    onOpen(project)
    acknowledgeSourceImport(project.id)
    onClose()
  }

  return <Dialog open onOpenChange={open => { if (!open) { task.current?.abort(); onClose() } }}>
    <DialogContent aria-busy={busy}>
      <DialogHeader><DialogTitle>Import saved source</DialogTitle><DialogDescription>Upload a source-only CodeTutor JSON export to your signed-in account. Your existing projects and the original export file will not be changed.</DialogDescription></DialogHeader>
      <p className="text-sm text-muted-foreground">Source opens as a new, ungraded Playground project. Chat history, activity scores, sandbox credentials and running processes are not imported here. No code runs during import. For full-history NDJSON files, use Import archive instead.</p>
      {!project ? <label className="space-y-2 text-sm"><span>Source project export (.json)</span><input aria-label="Source project export" className="block w-full rounded border border-border p-2" type="file" accept="application/json,.json" disabled={busy} onChange={event => { setFile(event.target.files?.[0]); setError(undefined) }} /></label> : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <p role="status" aria-live="polite" className="min-h-10 text-sm">{project ? 'All source is saved. Open the imported project when ready.' : busy ? receipt ? `Uploading: ${receipt.uploadedFiles} of ${receipt.fileCount} files verified…` : 'Checking the import…' : paused ? 'Import paused. Choose the same export file to resume, or cancel the staged upload.' : receipt?.state === 'uploading' ? `Pending upload: ${receipt.uploadedFiles} of ${receipt.fileCount} files. Choose the original export file to resume.` : receipt?.state === 'cancelled' ? 'Staged upload cancelled. No project was removed.' : 'Up to 200 files, 256 KB per file and 10 MB of source. The project appears only after every file is verified.'}</p>
      <DialogFooter className="flex-wrap">
        <Button variant="outline" onClick={() => busy ? task.current?.abort() : onClose()}>{busy ? 'Pause import' : 'Close'}</Button>
        {!project ? <Button variant="outline" disabled={busy} onClick={() => void run(true)}>Cancel staged import</Button> : null}
        {project ? <Button onClick={openProject} disabled={busy}>Open imported project</Button> : <Button disabled={busy || !file} onClick={() => void run()}>{error || paused || receipt?.state === 'uploading' ? 'Retry / resume import' : 'Import source'}</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
