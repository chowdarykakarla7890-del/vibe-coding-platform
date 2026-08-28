'use client'

import { memo, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { downloadImportedArchive, readImportedArchivePage } from '@/lib/learning/archive-import'
import { archiveRecordSchema, type ArchiveEnvelope } from '@/lib/projects/archive'
import type { ImportedArchivePage } from '@/lib/projects/archive-import'

const HistoryRecord = memo(function HistoryRecord({ envelope }: { envelope: ArchiveEnvelope }) {
  const record = archiveRecordSchema.parse(JSON.parse(envelope.record))
  const preview = JSON.stringify(record.data, null, 2)
  return <details className="rounded border border-border p-3">
    <summary className="cursor-pointer break-all text-sm focus-visible:outline-2"><span className="font-medium">{record.kind}</span> · {record.key}</summary>
    <p className="mt-2 break-all text-xs text-muted-foreground">{envelope.sectionId ? `Earlier archive ${envelope.sectionId} · record ${envelope.sectionIndex}` : record.kind === 'archive-section' ? 'Earlier imported-history section · unverified evidence' : 'Original imported project · unverified evidence'}</p>
    <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">{preview.slice(0, 10_000)}{preview.length > 10_000 ? '\n… Preview truncated. Download the original archive for the full record.' : ''}</pre>
  </details>
})

export function ProjectImportedHistory({ projectId, onClose, onReturnFocus }: { projectId: string; onClose: () => void; onReturnFocus?: () => void }) {
  const [page, setPage] = useState<ImportedArchivePage>(), [busy, setBusy] = useState(true)
  const [error, setError] = useState<string>(), [progress, setProgress] = useState<string>()
  const [cursors, setCursors] = useState([0])
  const task = useRef<AbortController | null>(null), mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    const controller = new AbortController()
    task.current = controller
    void readImportedArchivePage(projectId, 0, controller.signal).then(value => {
      if (mounted.current && !controller.signal.aborted) setPage(value)
    }).catch(cause => {
      if (mounted.current && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Imported history could not be loaded.')
    }).finally(() => { if (task.current === controller) { task.current = null; if (mounted.current) setBusy(false) } })
    return () => { mounted.current = false; controller.abort(); task.current?.abort() }
  }, [projectId])

  async function run(nextCursors?: number[]) {
    if (task.current) return
    const controller = new AbortController()
    task.current = controller
    setBusy(true); setError(undefined); setProgress(undefined)
    try {
      if (nextCursors) {
        const value = await readImportedArchivePage(projectId, nextCursors.at(-1)!, controller.signal)
        if (mounted.current && !controller.signal.aborted) { setPage(value); setCursors(nextCursors) }
      } else {
        const blob = await downloadImportedArchive(projectId, controller.signal, (count, total) => {
          if (mounted.current && !controller.signal.aborted) setProgress(`Verified ${count} of ${total} records…`)
        })
        if (!mounted.current || controller.signal.aborted) return
        const url = URL.createObjectURL(blob), link = document.createElement('a')
        link.href = url; link.download = 'original.codetutor-archive.ndjson'; link.click()
        setTimeout(() => URL.revokeObjectURL(url), 60_000)
        setProgress('Original archive verified. Download started.')
      }
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Imported history could not be loaded.')
    } finally {
      if (task.current === controller) task.current = null
      if (mounted.current) setBusy(false)
    }
  }
  return <Dialog open onOpenChange={open => { if (!open) { task.current?.abort(); onClose() } }}>
    <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl" aria-busy={busy} onCloseAutoFocus={event => { if (onReturnFocus) { event.preventDefault(); onReturnFocus() } }}>
      <DialogHeader><DialogTitle>Imported history</DialogTitle><DialogDescription>Original archive records are read-only and unverified. Imported tools never run, and archived scores do not count toward verified progress.</DialogDescription></DialogHeader>
      <p className="text-sm text-muted-foreground">Full project archive includes your current saved work and all imported evidence in one file. Download original archive below only if you want the unchanged file that was imported into this project.</p>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <p role="status" aria-live="polite" className="min-h-5 text-sm">{progress ?? (busy ? 'Loading verified archive records…' : page ? `Showing records ${page.records[0].index}–${page.records.at(-1)!.index} of ${page.manifest.recordCount}.` : 'No imported archive is available for this project.')}</p>
      <div className="space-y-2">
        {page?.records.map(envelope => <HistoryRecord key={envelope.index} envelope={envelope} />)}
      </div>
      <DialogFooter className="flex-wrap">
        <Button variant="outline" onClick={() => { task.current?.abort(); onClose() }}>Close</Button>
        {error ? <Button variant="outline" disabled={busy} onClick={() => void run(cursors)}>Retry history</Button> : null}
        <Button variant="outline" disabled={busy || cursors.length <= 1} onClick={() => void run(cursors.slice(0, -1))}>Previous</Button>
        <Button variant="outline" disabled={busy || page?.nextCursor == null} onClick={() => { if (page?.nextCursor != null) void run([...cursors, page.nextCursor]) }}>Next</Button>
        <Button disabled={busy || !page} onClick={() => void run()}>Download original archive</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
