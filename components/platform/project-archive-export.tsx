'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { downloadProjectArchive } from '@/lib/learning/project-archive'
import { useSandboxStore } from '@/app/state'

export function ProjectArchiveExport({ projectId, title, onClose, onReturnFocus }: { projectId: string; title: string; onClose: () => void; onReturnFocus?: () => void }) {
  const [progress, setProgress] = useState<{ saved: number; total: number; waitingSeconds?: number }>()
  const [busy, setBusy] = useState(false)
  const [cancelled, setCancelled] = useState(false)
  const [error, setError] = useState<string>()
  const [complete, setComplete] = useState(false)
  const task = useRef<AbortController | null>(null)
  const mounted = useRef(false)
  const dirty = useSandboxStore(state => Boolean(state.dirtyFilePath))
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; task.current?.abort() }
  }, [])

  async function download() {
    if (task.current) return
    const controller = new AbortController()
    task.current = controller
    setBusy(true); setError(undefined); setComplete(false); setCancelled(false); setProgress(undefined)
    try {
      const blob = await downloadProjectArchive(projectId, controller.signal, (saved, total, waitingSeconds) => {
        if (mounted.current && !controller.signal.aborted) setProgress({ saved, total, waitingSeconds })
      })
      if (controller.signal.aborted || !mounted.current) return
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${title.replace(/[^a-z0-9]+/gi, '-').slice(0, 80) || 'project'}.codetutor-archive.ndjson`
      link.click()
      // Allow the browser to consume the Blob before releasing its URL.
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
      setComplete(true)
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'The archive could not be downloaded. Retry without deleting your project.')
    } finally {
      if (task.current === controller) task.current = null
      if (mounted.current) { setBusy(false); if (controller.signal.aborted) setCancelled(true) }
    }
  }
  function cancel() { task.current?.abort(); setCancelled(true) }

  return <Dialog open onOpenChange={value => { if (!value) { if (busy) cancel(); onClose() } }}>
      <DialogContent aria-busy={busy} onCloseAutoFocus={event => { if (onReturnFocus) { event.preventDefault(); onReturnFocus() } }}>
        <DialogHeader><DialogTitle>Export full project archive</DialogTitle><DialogDescription>Download saved source, chat, conflict copies, activity submissions and scores for “{title}”. This creates a frozen copy; it does not stop the sandbox or change your project.</DialogDescription></DialogHeader>
        <p className="text-sm text-muted-foreground">Unsaved editor drafts and uncaptured sandbox changes are not included. Save your files and wait for background source saving first. Keep the download private: your own source and messages may contain sensitive information.</p>
        <p className="text-xs text-muted-foreground">Restore this NDJSON file with Import archive. It includes your current saved work and any earlier imported history in one file. Historical records remain read-only and unverified; only the current source is restored.</p>
        {dirty ? <p role="alert" className="text-sm">Save your open editor draft before exporting.</p> : null}
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <p role="status" aria-live="polite" className="min-h-5 text-sm">{busy ? cancelled ? 'Cancelling and cleaning up the temporary export…' : progress?.waitingSeconds ? `Export paused by the request limit. Continuing in ${progress.waitingSeconds} seconds…` : progress ? `Verified ${progress.saved} of ${progress.total} records…` : 'Preparing a consistent archive…' : complete ? 'Archive verified. Download started.' : cancelled ? 'Export cancelled. Your project is unchanged.' : 'Ready to export saved project data.'}</p>
        <DialogFooter><Button variant="outline" onClick={() => busy ? cancel() : onClose()} disabled={busy && cancelled}>{busy ? 'Cancel export' : 'Close'}</Button><Button disabled={busy || dirty} onClick={() => void download()}>{busy ? 'Exporting…' : error ? 'Retry export' : 'Download archive'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
}
