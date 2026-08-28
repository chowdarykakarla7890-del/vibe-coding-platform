'use client'

import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useLearning } from '@/lib/learning/learning-provider'
import { cloudOperation } from '@/lib/learning/cloud-request'
import { getApiErrorMessage } from '@/lib/api-error'
import { useSandboxStore } from '@/app/state'
import { readWithDeadline } from '@/lib/abortable-read'
import { applyResolutionReceiptSchema, conflictDetailSchema, recoveryPageSchema, recoveryStatusText, resolutionReceiptSchema, resolutionRequestSchema, type ConflictDetail, type ResolutionRequest } from '@/lib/source-recovery'

async function read<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal, body?: unknown) {
  const operation = cloudOperation(signal)
  return readWithDeadline(async requestSignal => {
  const response = await operation.fetch(path, { signal: requestSignal, cache: 'no-store',
    ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const data: unknown = await response.json().catch(() => undefined)
  operation.assertActive(); signal.throwIfAborted()
  if (!response.ok) throw new Error(getApiErrorMessage(data, 'Source recovery is unavailable. Retry without clearing saved work.'))
  const parsed = schema.safeParse(data)
  if (!parsed.success) throw new Error('Source recovery returned an invalid response. Reload the review before continuing.')
  return parsed.data
  }, signal, body === undefined ? 20_000 : 55_000, 'Source recovery timed out. Reload or retry the same operation to confirm its result; saved copies are unchanged.')
}

export function SourceRecovery() {
  const { activeProjectId } = useLearning()
  return activeProjectId ? <ProjectRecovery key={activeProjectId} projectId={activeProjectId} /> : null
}

export function ProjectRecovery({ projectId }: { projectId: string }) {
  const [page, setPage] = useState<z.infer<typeof recoveryPageSchema>>()
  const [error, setError] = useState<string>()
  const [open, setOpen] = useState(false)
  const [history, setHistory] = useState(false)
  const [cursor, setCursor] = useState<string>()
  const [selected, setSelected] = useState<string>()
  const [version, setVersion] = useState(0)
  const dirtyReview = useRef(false)
  const retryRequest = useRef<AbortController | null>(null)
  const [retrying, setRetrying] = useState(false)
  const [retryMessage, setRetryMessage] = useState<string>()
  const endpoint = `/api/projects/${projectId}/source-recovery`

  useEffect(() => () => { retryRequest.current?.abort() }, [endpoint])

  async function retryCaptures() {
    if (retryRequest.current) return
    const controller = new AbortController(); retryRequest.current = controller
    setRetrying(true); setRetryMessage(undefined)
    try {
      const result = await read(endpoint, z.object({ resumed: z.number().int().min(0).max(10) }), controller.signal, { action: 'retry' })
      if (controller.signal.aborted) return
      setRetryMessage(result.resumed ? `${result.resumed} background save(s) queued. Keep the sandbox running; the scheduled worker will retry them.` : 'No paused saves could be resumed. Refreshing their status.')
      setVersion((value) => value + 1)
    } catch (error) {
      if (!controller.signal.aborted) setRetryMessage(error instanceof Error ? error.message : 'Could not retry background saves.')
    } finally {
      if (retryRequest.current === controller) retryRequest.current = null
      if (!controller.signal.aborted) setRetrying(false)
    }
  }

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let loading = false
    let failed = false
    async function refresh() {
      clearTimeout(timer)
      if (loading || failed || document.visibilityState === 'hidden') return
      loading = true
      try {
        const query = new URLSearchParams({ ...(history ? { history: '1' } : {}), ...(cursor ? { after: cursor } : {}) })
        const result = await read(`${endpoint}?${query}`, recoveryPageSchema, controller.signal)
        if (controller.signal.aborted) return
        setPage(result); setError(undefined)
        timer = setTimeout(() => void refresh(), 15_000)
      } catch (error) {
        failed = true
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Could not load source recovery.')
        // A terminal/auth/network failure requires explicit retry, not a loop.
      } finally { loading = false }
    }
    function visibility() { if (document.visibilityState === 'hidden') clearTimeout(timer); else void refresh() }
    void refresh()
    document.addEventListener('visibilitychange', visibility)
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', visibility) }
  }, [endpoint, cursor, history, version])

  const leaveReview = () => !dirtyReview.current || window.confirm('Discard the unsaved merge draft? The preserved source copies will remain saved.')
  const refresh = () => setVersion((value) => value + 1)
  return <>
    <section aria-label="Source recovery" className="flex min-h-9 shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-1 text-xs">
      <span role="status" className="min-w-0 flex-1 text-muted-foreground">{error ? 'Source recovery status unavailable' : page ? recoveryStatusText(page) : 'Checking saved source…'}</span>
      {error ? <Button size="sm" variant="ghost" onClick={refresh}>Retry status</Button> : null}
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>Review source</Button>
    </section>
    <Dialog open={open} onOpenChange={(next) => { if (next || leaveReview()) { setOpen(next); if (!next) { setSelected(undefined); dirtyReview.current = false } } }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Source recovery</DialogTitle>
          <DialogDescription>Review saved and terminal versions. Save your choice first, then explicitly apply it to an idle sandbox. Original copies remain available.</DialogDescription>
        </DialogHeader>
        {selected ? <>
          <Button className="justify-self-start" variant="ghost" onClick={() => { if (leaveReview()) { setSelected(undefined); dirtyReview.current = false; refresh() } }}>Back to reviews</Button>
          <ConflictReview key={selected} endpoint={`${endpoint}/${selected}`} onResolved={refresh} onDirty={(dirty) => { dirtyReview.current = dirty }} />
        </> : <>
          <div className="flex gap-2">
            <Button variant={history ? 'ghost' : 'secondary'} aria-pressed={!history} onClick={() => { setHistory(false); setCursor(undefined); setPage(undefined) }}>Needs review</Button>
            <Button variant={history ? 'secondary' : 'ghost'} aria-pressed={history} onClick={() => { setHistory(true); setCursor(undefined); setPage(undefined) }}>Resolved copies</Button>
          </div>
          {error ? <div role="alert"><p className="text-sm">{error}</p><Button className="mt-2" variant="outline" onClick={refresh}>Retry source reviews</Button></div> : null}
          {page?.pending ? <p className="text-sm text-muted-foreground">{page.pending} command capture(s) pending. Keep the sandbox running until capture finishes.</p> : null}
          {page?.paused ? <div className="space-y-2"><p className="text-sm">{page.paused} background save(s) paused after repeated failures. Saved source and captured review copies are unchanged. Retry while the original sandbox is still running.</p>
            <Button disabled={retrying} variant="outline" onClick={() => void retryCaptures()}>{retrying ? 'Queuing saves…' : 'Retry background saves'}</Button></div> : null}
          {retryMessage ? <p role="status" className="text-sm">{retryMessage}</p> : null}
          {page?.savedOnly ? <p role="status" className="text-sm">Saved resolutions are available in Resolved copies. Apply or recheck each resolution there while commands are stopped. This count is not a live synchronization check.</p> : null}
          {page && (page.incomplete > 0 || page.expired > 0) ? <p role="status" className="text-sm">Some captures were incomplete or the sandbox stopped before capture finished. Saved copies remain available, but unsaved terminal changes may be missing.</p> : null}
          {!page && !error ? <p role="status">Loading source reviews…</p> : null}
          {page?.conflicts.length === 0 ? <p className="text-sm text-muted-foreground">{history ? 'No resolved copies yet.' : 'No unresolved source conflicts.'}</p> : null}
          <ul className="space-y-2">{page?.conflicts.map((item) => <li key={item.id}>
            <Button className="h-auto w-full justify-start whitespace-normal break-all text-left" variant="outline" onClick={() => setSelected(item.id)}>{item.path}<span className="ml-auto pl-3 text-xs text-muted-foreground">{item.resolvedAt ? 'Resolved' : 'Review'}</span></Button>
          </li>)}</ul>
          <div className="flex gap-2">{cursor ? <Button variant="outline" onClick={() => { setCursor(undefined); setPage(undefined) }}>First page</Button> : null}
            {page?.nextCursor ? <Button variant="outline" onClick={() => { setCursor(page.nextCursor!); setPage(undefined) }}>More reviews</Button> : null}</div>
        </>}
      </DialogContent>
    </Dialog>
  </>
}

export function ConflictReview({ endpoint, onResolved, onDirty }: { endpoint: string; onResolved: () => void; onDirty: (dirty: boolean) => void }) {
  const sandboxId = useSandboxStore(state => state.sandboxId)
  const sandboxStatus = useSandboxStore(state => state.status)
  const [detail, setDetail] = useState<ConflictDetail>()
  const [error, setError] = useState<string>()
  const [merge, setMerge] = useState('')
  const [merging, setMerging] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [applied, setApplied] = useState<{ sandboxId: string; revision: number }>()
  const [reload, setReload] = useState(0)
  const [loading, setLoading] = useState(true)
  const busyRef = useRef(false)
  const requests = useRef(new Set<AbortController>())
  const initialized = useRef(false)
  useEffect(() => {
    const pending = requests.current
    return () => { for (const controller of pending) controller.abort(); pending.clear() }
  }, [])
  useEffect(() => {
    const controller = new AbortController(); requests.current.add(controller)
    void read(endpoint, conflictDetailSchema, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      setDetail(result); setError(undefined)
      if (!initialized.current) { setMerge(result.conflict.captured ?? result.current.content ?? ''); initialized.current = true }
    }).catch((error) => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Could not open this review.') })
      .finally(() => { requests.current.delete(controller); if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [endpoint, reload])
  useEffect(() => {
    function warn(event: BeforeUnloadEvent) { if (dirty) event.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  async function resolve(choice: ResolutionRequest['choice']) {
    if (!detail || detail.resolution || busyRef.current || loading) return
    const input = resolutionRequestSchema.safeParse({ choice, revision: detail.current.revision, ...(choice === 'merged' ? { content: merge } : {}) })
    if (!input.success) { setError('Keep the merged source under 256 KB and remove null characters.'); return }
    if (!window.confirm(`Save this ${choice === 'saved' ? 'saved version' : choice === 'captured' ? 'terminal version' : 'merge'} for ${detail.conflict.path}? Original copies remain in Resolved copies. Running sandbox files will not be replaced.`)) return
    busyRef.current = true; setBusy(true); setError(undefined)
    const controller = new AbortController(); requests.current.add(controller)
    try {
      const receipt = await read(endpoint, resolutionReceiptSchema, controller.signal, input.data)
      if (controller.signal.aborted) return
      if (receipt.id !== detail.conflict.id || receipt.path !== detail.conflict.path || receipt.choice !== choice || receipt.revision < detail.current.revision) throw new Error('The resolution receipt did not match this file. Reload the review.')
      setDetail({ ...detail, resolution: receipt }); setDirty(false); onDirty(false); onResolved()
    } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Resolution could not be confirmed.') }
    finally { requests.current.delete(controller); busyRef.current = false; if (!controller.signal.aborted) setBusy(false) }
  }
  async function apply() {
    if (!detail?.resolution || !sandboxId || sandboxStatus !== 'running' || busyRef.current || loading) return
    if (useSandboxStore.getState().dirtyFilePath === detail.conflict.path) {
      setError('Save or copy your unsaved editor draft before applying this resolution. Your draft has not been changed.')
      return
    }
    if (!window.confirm(`Apply saved revision ${detail.resolution.revision} to ${detail.conflict.path}? Stop all terminal commands and the preview server first. The application will refuse to overwrite newer terminal changes.`)) return
    const originSandboxId = sandboxId
    const resolution = detail.resolution
    busyRef.current = true; setBusy(true); setError(undefined)
    const controller = new AbortController(); requests.current.add(controller)
    try {
      const receipt = await read(`${endpoint}/apply`, applyResolutionReceiptSchema, controller.signal, { sandboxId: originSandboxId, revision: resolution.revision })
      if (receipt.id !== resolution.id || receipt.path !== resolution.path || receipt.revision !== resolution.revision || receipt.deleted !== resolution.deleted || receipt.sandboxId !== originSandboxId) throw new Error('Application receipt did not match this review. Retry to confirm the saved revision; no editor draft has been replaced.')
      if (controller.signal.aborted || useSandboxStore.getState().sandboxId !== originSandboxId) return
      useSandboxStore.getState().notifySourceApplied(originSandboxId, receipt)
      setApplied({ sandboxId: originSandboxId, revision: receipt.revision }); onResolved()
    } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Application could not be confirmed. Retry the same resolution.') }
    finally { requests.current.delete(controller); busyRef.current = false; if (!controller.signal.aborted) setBusy(false) }
  }
  function download() {
    if (!detail) return
    const url = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, kind: 'codetutor-source-review', path: detail.conflict.path,
      captured: detail.conflict.captured, saved: detail.current, resolution: detail.resolution,
    }, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = 'codetutor-source-review.json'; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
  return <section className="space-y-3" aria-busy={busy || loading}>
    {loading ? <p role="status">Loading comparison…</p> : null}
    {error ? <p role="alert" className="text-sm">{error}</p> : null}
    <Button variant="outline" disabled={busy || loading} onClick={() => { setLoading(true); setReload((value) => value + 1) }}>Reload comparison</Button>
    {detail ? <>
      <h3 className="break-all font-mono text-sm">{detail.conflict.path}</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <SourceCopy label={detail.resolution ? 'Saved version reviewed' : 'Latest saved version'} content={detail.current.content} />
        <SourceCopy label="Captured terminal version" content={detail.conflict.captured} />
      </div>
      <Button variant="outline" onClick={download}>Download both copies</Button>
      {detail.resolution ? <div className="space-y-2">
        <p role="status" className="text-sm">Resolved using {detail.resolution.choice === 'merged' ? 'a manual merge' : `the ${detail.resolution.choice} version`}. Saved revision {detail.resolution.revision}{detail.resolution.deleted ? ' (deleted)' : ''}.</p>
        {applied && applied.sandboxId === sandboxId ? <p role="status" className="text-sm">Revision {applied.revision} was applied and the editor was notified. Later terminal or editor changes can differ; recheck before relying on an old receipt.</p> : null}
        <p className="text-xs text-muted-foreground">Application requires all terminal commands and preview servers to be stopped. Expired sandboxes must be restored first. Newer saved or terminal changes are never overwritten by this review.</p>
        <Button disabled={busy || loading || !sandboxId || sandboxStatus !== 'running'} variant="outline" onClick={() => void apply()}>{busy ? 'Checking and applying…' : applied && applied.sandboxId === sandboxId ? 'Recheck application' : 'Apply to sandbox'}</Button>
      </div> : <>
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy || loading} variant="outline" onClick={() => void resolve('saved')}>Keep saved version</Button>
          <Button disabled={busy || loading} variant="outline" onClick={() => void resolve('captured')}>{detail.conflict.captured === null ? 'Accept terminal deletion' : 'Use terminal version'}</Button>
          <Button disabled={busy || loading} variant="ghost" onClick={() => setMerging(true)}>Merge manually</Button>
        </div>
        {merging ? <div className="space-y-2"><label htmlFor={`merge-${detail.conflict.id}`} className="text-sm">Merged source</label>
          <textarea id={`merge-${detail.conflict.id}`} className="h-48 w-full rounded-md border border-border bg-background p-3 font-mono text-xs" value={merge} disabled={busy} onChange={(event) => { setMerge(event.target.value); setDirty(true); onDirty(true) }} />
          <Button disabled={busy || loading} onClick={() => void resolve('merged')}>{busy ? 'Saving resolution…' : 'Save merged version'}</Button></div> : null}
      </>}
    </> : null}
  </section>
}

function SourceCopy({ label, content }: { label: string; content: string | null }) {
  return <div><h4 className="mb-2 text-xs text-muted-foreground">{label}</h4><pre tabIndex={0} aria-label={label} className="max-h-52 min-h-24 overflow-auto rounded-md border border-border bg-background p-3 font-mono text-xs">{content === null ? '(File absent or deleted)' : content === '' ? '(Empty file)' : content}</pre></div>
}
