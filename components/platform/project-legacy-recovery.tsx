'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ZodError } from 'zod'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useWorkspaceAccount } from '@/components/auth/user-workspace'
import { cloudOperation } from '@/lib/learning/cloud-request'
import { listLegacyProjects, type LegacyProjectPage } from '@/lib/learning/legacy-device-db'
import { prepareLegacyArchive, type LegacyArchive } from '@/lib/learning/legacy-device-archive'

interface Props { onClose: () => void; onContinue: (file: File) => void }

export function ProjectLegacyRecovery(props: Props) {
  const account = useWorkspaceAccount()
  return <AccountRecovery key={account.userId} {...props} account={account} />
}

function message(error: unknown) {
  if (error instanceof ZodError) return 'A saved device record is invalid or exceeds recovery limits. Nothing was imported or deleted. Keep the original device storage for recovery.'
  return error instanceof Error ? error.message : 'Device recovery could not finish. The original data is unchanged.'
}

function filename(title: string) { return `${title.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'project'}.device-backup.ndjson` }

function AccountRecovery({ account, onClose, onContinue }: Props & { account: { userId: string; email?: string } }) {
  const [page, setPage] = useState<LegacyProjectPage>({ projects: [], nextCursor: null })
  const [busy, setBusy] = useState(true), [error, setError] = useState<string>()
  const [selected, setSelected] = useState(''), [prepared, setPrepared] = useState<LegacyArchive>()
  const [consent, setConsent] = useState(false)
  const task = useRef<AbortController | null>(null), mounted = useRef(false)

  const loadPage = useCallback(async (after?: string) => {
    if (task.current) return
    const controller = new AbortController()
    task.current = controller
    setBusy(true); setError(undefined)
    try {
      const owner = cloudOperation(controller.signal)
      if (owner.userId !== account.userId) throw new Error('The signed-in account changed. Reopen device recovery.')
      const value = await listLegacyProjects(owner.signal, after)
      owner.assertActive()
      if (!mounted.current) return
      setPage(previous => ({ projects: after ? [...previous.projects, ...value.projects] : value.projects, nextCursor: value.nextCursor }))
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) setError(message(cause))
    } finally {
      if (task.current === controller) { task.current = null; if (mounted.current) setBusy(false) }
    }
  }, [account.userId])

  useEffect(() => {
    mounted.current = true
    const timer = setTimeout(() => void loadPage(), 0)
    return () => { clearTimeout(timer); mounted.current = false; task.current?.abort(); task.current = null }
  }, [loadPage])

  async function prepare() {
    if (task.current || !selected) return
    const controller = new AbortController()
    task.current = controller
    setBusy(true); setPrepared(undefined); setConsent(false); setError(undefined)
    try {
      const owner = cloudOperation(controller.signal)
      if (owner.userId !== account.userId) throw new Error('The signed-in account changed. Reopen device recovery.')
      const backup = await prepareLegacyArchive(selected, owner.signal)
      owner.assertActive()
      if (mounted.current) setPrepared(backup)
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) setError(message(cause))
    } finally {
      if (task.current === controller) { task.current = null; if (mounted.current) setBusy(false) }
    }
  }

  function continueImport() {
    if (!prepared || !consent || busy) return
    try {
      const owner = cloudOperation()
      owner.assertActive()
      if (owner.userId !== account.userId) throw new Error('The signed-in account changed. Reopen device recovery and confirm the destination again.')
      onContinue(new File([prepared.blob], filename(prepared.title), { type: 'application/x-ndjson' }))
    } catch (cause) { setError(message(cause)) }
  }

  function download() {
    if (!prepared) return
    try {
      const url = URL.createObjectURL(prepared.blob)
      const link = document.createElement('a')
      try {
        link.href = url; link.download = filename(prepared.title)
        document.body.appendChild(link); link.click()
      } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1_000) }
    } catch { setError('The browser could not download this backup. Retry without clearing device storage.') }
  }
  function close() { task.current?.abort(); onClose() }

  return <Dialog open onOpenChange={open => { if (!open) close() }}>
    <DialogContent aria-busy={busy} className="max-h-[90dvh] overflow-y-auto">
      <DialogHeader><DialogTitle>Recover device projects</DialogTitle><DialogDescription>Find work saved by the earlier local-only CodeTutor on this browser and site. Nothing is uploaded until you confirm an account and start the import.</DialogDescription></DialogHeader>
      <p className="text-sm text-muted-foreground">The original device database stays unchanged. Other account caches are never searched. If nothing appears, use the original browser and site address; do not clear site data.</p>
      {!prepared ? <>
        <label className="space-y-2 text-sm"><span>Device project</span>
          <select aria-label="Device project" disabled={busy} value={selected} className="block w-full rounded border border-border bg-background p-2" onChange={event => { setSelected(event.target.value); setError(undefined); setConsent(false) }}>
            <option value="">Choose a device project</option>
            {page.projects.map(project => <option key={project.id} value={project.id} disabled={!project.readable}>{project.title} · {project.language}{!project.readable ? ' (cannot prepare automatically)' : ''}</option>)}
          </select>
        </label>
        {page.projects.some(project => !project.readable) ? <p className="text-sm">An unreadable project was found. It has been left untouched for manual recovery.</p> : null}
        {page.nextCursor ? <Button disabled={busy} variant="outline" onClick={() => void loadPage(page.nextCursor!)}>Load more device projects</Button> : null}
        {!busy && !error && !page.projects.length ? <p role="status">No earlier device projects were found here.</p> : null}
      </> : <section className="space-y-3 rounded border border-border p-3 text-sm">
        <h3 className="font-medium break-words">{prepared.title}</h3>
        <p>{prepared.fileCount} source files · {prepared.messageCount} messages · {prepared.attemptCount} attempts</p>
        <p>All available project history, associated activity summaries and selected portfolio details are included as unverified evidence. Scores do not become verified progress, and imported tools never run.</p>
        <Button variant="outline" onClick={download}>Download device backup</Button>
        <p className="text-xs text-muted-foreground">Keep this backup private: source and messages may contain secrets. Runtime credentials are removed, but this is not a general secret scanner. Download the original backup to resume if local work changes during an upload.</p>
        <label className="flex items-start gap-2 break-words"><input type="checkbox" className="mt-1 shrink-0" checked={consent} onChange={event => setConsent(event.target.checked)} /><span>I confirm this is my project and want to copy it to {account.email ?? account.userId}.</span></label>
      </section>}
      {error ? <div className="space-y-2"><p role="alert" className="text-sm text-destructive">{error}</p>{!prepared ? <Button disabled={busy} variant="outline" onClick={() => void loadPage()}>Retry device scan</Button> : null}</div> : null}
      <p role="status" aria-live="polite" className="min-h-5 text-sm text-muted-foreground">{busy ? selected ? 'Preparing a validated backup on this device…' : 'Looking for device projects…' : prepared ? 'Backup prepared locally. No data has been uploaded.' : 'Choose a project to prepare its complete backup.'}</p>
      <DialogFooter className="flex-wrap">
        <Button variant="outline" onClick={close}>{busy ? 'Cancel recovery' : 'Close'}</Button>
        {prepared ? <><Button variant="outline" onClick={() => { setPrepared(undefined); setConsent(false); setError(undefined) }}>Choose another project</Button><Button disabled={!consent || busy} onClick={continueImport}>Continue to account import</Button></>
          : <Button disabled={busy || !selected || !page.projects.some(project => project.id === selected && project.readable)} onClick={() => void prepare()}>Prepare local backup</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
