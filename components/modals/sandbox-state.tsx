'use client'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useSandboxStore } from '@/app/state'
import { Component, useEffect, useRef, useState, type ReactNode } from 'react'
import { useLearning } from '@/lib/learning/learning-provider'
import { listFileSnapshots } from '@/lib/learning/db'
import { readSandboxLifecycle, requestSandboxShutdown, restoreProjectSandbox, SandboxReopenRequiredError } from '@/lib/learning/sandbox-recovery'
import type { SandboxLifecycle } from '@/lib/sandbox/lifecycle'
import { toast } from 'sonner'
import { errorDiagnostics } from '@/lib/client/error-diagnostics'

export function SandboxState() {
  const sandboxId = useSandboxStore((state) => state.sandboxId)
  const { activeProject } = useLearning()
  // Never show another project's expiration dialog during project hydration.
  if (!sandboxId || !activeProject || activeProject.sandboxId !== sandboxId) return null
  return (
    <SandboxRecoveryBoundary key={`${activeProject.id}:${sandboxId}`}>
      <ProjectSandboxState projectId={activeProject.id} sandboxId={sandboxId} />
    </SandboxRecoveryBoundary>
  )
}

// This panel is mounted in the platform layout, outside the route's error
// boundary. A rendering failure here must not unmount the editor/chat or send
// the entire application to global-error. Retrying remounts only recovery UI;
// it never deletes saved data or creates a replacement automatically.
class SandboxRecoveryBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: unknown) {
    // JavaScript can throw null or a primitive. Recovery must not throw again
    // while reporting the original failure and take down the whole workspace.
    console.error('Sandbox recovery panel failed', errorDiagnostics(error))
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <aside role="alert" className="fixed bottom-4 right-4 z-40 max-w-sm rounded-lg border border-border bg-card p-4 text-sm shadow-lg">
        <p className="font-medium">Sandbox recovery could not open</p>
        <p className="mt-1 text-muted-foreground">Your workspace is still open and no saved files have been cleared. Retry the recovery controls without reloading your project.</p>
        <Button className="mt-3" size="sm" variant="outline" onClick={() => this.setState({ failed: false })}>
          Retry sandbox recovery
        </Button>
      </aside>
    )
  }
}

function ProjectSandboxState({ projectId, sandboxId }: { projectId: string; sandboxId: string }) {
  const status = useSandboxStore((state) => state.status)
  const { updateProject } = useLearning()
  const [restorePhase, setRestorePhase] = useState<'idle' | 'restoring' | 'committing' | 'cancelling'>('idle')
  const restoring = restorePhase !== 'idle'
  const [dismissed, setDismissed] = useState(false)
  const reopenButton = useRef<HTMLButtonElement>(null)
  const [restoreError, setRestoreError] = useState<string>()
  const [reopenRequired, setReopenRequired] = useState(false)
  const [statusError, setStatusError] = useState<string>()
  const [shutdown, setShutdown] = useState<SandboxLifecycle['shutdown']>()
  const [retryingShutdown, setRetryingShutdown] = useState(false)
  const shutdownController = useRef<AbortController | null>(null)
  const [checkVersion, setCheckVersion] = useState(0)
  const terminalCheckVersion = useRef<number | undefined>(undefined)
  const restoreController = useRef<{ controller: AbortController; cancellable: boolean } | null>(null)
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; restoreController.current?.controller.abort(); shutdownController.current?.abort() }
  }, [])

  useEffect(() => {
    // The workspace can already know the VM stopped before this panel mounts.
    // Still read its final-save/conflict receipt once; the local status alone
    // cannot say whether shutdown saved everything. Only explicit Retry should
    // recheck a settled terminal state.
    if (status === 'stopped' && terminalCheckVersion.current === checkVersion) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    async function check() {
      try {
        const next = await readSandboxLifecycle(sandboxId, controller.signal)
        if (controller.signal.aborted) return
        const current = useSandboxStore.getState()
        if (current.sandboxId !== sandboxId) return
        if (current.status === 'stopped' || next.status === 'stopped') {
          terminalCheckVersion.current = checkVersion
        }
        if (current.status === 'stopped' && next.status !== 'stopped') {
          // A delayed/cached status must not revive commands or the old preview.
          setStatusError('The sandbox returned an older status. Retry checking its final save; the workspace remains stopped.')
          return
        }
        if (current.status === 'stopping' && (next.status === 'ok' || next.status === 'running')) {
          setStatusError('The sandbox returned an older status. Commands remain paused. Retry checking the final save and shutdown.')
          return
        }
        setShutdown(next.shutdown)
        current.setSandboxStatus(sandboxId, next.status === 'ok' ? 'running' : next.status)
        setStatusError(undefined)
        if (next.status !== 'stopped') timer = setTimeout(() => void check(), 5_000)
      } catch (error) {
        if (controller.signal.aborted) return
        if (useSandboxStore.getState().status === 'stopped') terminalCheckVersion.current = checkVersion
        // Stop polling on failures and let the user explicitly retry.
        setStatusError(error instanceof Error ? error.message : 'Could not check this sandbox.')
      }
    }
    void check()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [sandboxId, status, checkVersion])

  async function restore() {
    // A ref also guards double clicks before React commits the disabled state.
    if (restoreController.current || reopenRequired) return
    const dirtyPath = useSandboxStore.getState().dirtyFilePath
    if (dirtyPath && !window.confirm(`Restoring will replace the open editor and its unsaved changes in ${dirtyPath}. Cancel and copy your draft first if you need to keep it. Continue restoring?`)) return
    const controller = new AbortController()
    const task = { controller, cancellable: true }
    restoreController.current = task
    setRestorePhase('restoring')
    setRestoreError(undefined)
    try {
      const result = await restoreProjectSandbox({
        projectId,
        signal: controller.signal,
        loadFiles: (signal) => listFileSnapshots(projectId, signal),
        onCommitting: () => {
          // Disable cancellation synchronously before the association write.
          // A cancelled wait cannot roll back an already committed save.
          task.cancellable = false
          if (mounted.current) setRestorePhase('committing')
        },
        commit: (replacementId) => updateProject(projectId, {
          sandboxId: replacementId,
          previewUrl: undefined,
        }),
      })
      if (controller.signal.aborted) return
      const current = useSandboxStore.getState()
      if (current.sandboxId !== sandboxId && current.sandboxId !== result.sandboxId) return
      if (current.sandboxId !== result.sandboxId) current.setSandboxId(result.sandboxId)
      useSandboxStore.getState().addPaths(result.files.map((file) => file.path))
      toast.success(`Restored ${result.files.length} files. Dependencies and the preview server may need restarting.`)
    } catch (error) {
      if (mounted.current) {
        setReopenRequired(error instanceof SandboxReopenRequiredError)
        setRestoreError(error instanceof SandboxReopenRequiredError ? error.message : controller.signal.aborted
          ? 'Restoration cancelled. Your saved snapshot is unchanged. You can retry.'
          : error instanceof Error ? error.message : 'Could not restore workspace. Please retry.')
      }
    } finally {
      if (restoreController.current === task) {
        restoreController.current = null
        if (mounted.current) setRestorePhase('idle')
      }
    }
  }

  function reopenProject() {
    const dirtyPath = useSandboxStore.getState().dirtyFilePath
    if (dirtyPath && !window.confirm(`Reopening will discard the unsaved editor draft in ${dirtyPath}. Cancel and copy it first if you need to keep it. Reopen now?`)) return
    window.location.reload()
  }

  function cancelRestore() {
    const task = restoreController.current
    if (!task?.cancellable) return
    task.cancellable = false
    setRestorePhase('cancelling')
    task.controller.abort()
  }

  async function retryShutdown() {
    if (shutdownController.current) return
    const controller = new AbortController()
    shutdownController.current = controller
    setRetryingShutdown(true)
    try {
      const next = await requestSandboxShutdown(sandboxId, controller.signal)
      if (controller.signal.aborted) return
      setShutdown(next.shutdown)
      setStatusError(undefined)
      useSandboxStore.getState().setSandboxStatus(sandboxId, next.status === 'ok' ? 'running' : next.status)
      setCheckVersion(version => version + 1)
    } catch (error) {
      if (!controller.signal.aborted) setStatusError(error instanceof Error ? error.message : 'Shutdown retry could not be confirmed.')
    } finally {
      if (shutdownController.current === controller) shutdownController.current = null
      if (mounted.current) setRetryingShutdown(false)
    }
  }

  if (status === 'stopping') return (
    <aside role="status" aria-live="polite" className="fixed bottom-4 right-4 z-40 max-w-sm rounded-lg border border-border bg-card p-4 text-sm shadow-lg">
      <p className="font-medium">{shutdown?.state === 'retryable' ? 'Final source save needs attention' : 'Saving final source before shutdown…'}</p>
      <p className="mt-1 text-muted-foreground">New commands are paused. The sandbox will stop only after its supported source files or conflicting copies are saved.</p>
      {statusError ? <p role="alert" className="mt-2">{statusError}</p> : null}
      {shutdown?.state === 'retryable' ? <Button className="mt-3" size="sm" variant="outline" disabled={retryingShutdown} onClick={() => void retryShutdown()}>{retryingShutdown ? 'Retrying…' : 'Retry save and shutdown'}</Button> : null}
      {statusError ? <Button className="mt-3" size="sm" variant="outline" onClick={() => { setStatusError(undefined); setCheckVersion(v => v + 1) }}>Retry connection</Button> : null}
    </aside>
  )

  if (status !== 'stopped') {
    return statusError ? (
      <aside role="status" className="fixed bottom-4 right-4 z-40 max-w-sm rounded-lg border border-border bg-card p-4 text-sm shadow-lg">
        <p>{statusError}</p>
        <Button className="mt-3" size="sm" variant="outline" onClick={() => { setStatusError(undefined); setCheckVersion((version) => version + 1) }}>Retry connection</Button>
      </aside>
    ) : null
  }

  return (
    <>
      {dismissed ? (
        <Button ref={reopenButton} className="fixed bottom-4 right-4 z-40 shadow-lg" variant="outline" onClick={() => setDismissed(false)}>
          {shutdown?.saved ? 'Sandbox stopped · Restore' : 'Sandbox expired · Restore'}
        </Button>
      ) : null}
      <Dialog open={!dismissed} onOpenChange={(open) => { if (!restoring) setDismissed(!open) }}>
        <DialogContent showCloseButton={!restoring} aria-busy={restoring} onCloseAutoFocus={(event) => {
          // Expiration opens this dialog without a DialogTrigger. Give keyboard
          // users a stable return target after Close, Not now, or Escape.
          if (reopenButton.current) {
            event.preventDefault()
            reopenButton.current.focus()
          }
        }}>
          <DialogHeader>
            <DialogTitle>{shutdown?.saved ? 'Sandbox stopped' : 'Sandbox expired'}</DialogTitle>
            <DialogDescription>
              {shutdown?.saved ? 'Final source was saved before shutdown. Restore your saved project into a new sandbox to continue coding.'
                : shutdown ? 'The sandbox ended before a complete final source save was confirmed. Earlier saved versions and learning history are still available; unsaved terminal changes may be missing.'
                  : 'The temporary coding environment has stopped. Expiration does not delete your saved chat or source snapshots. Restore a saved snapshot into a new sandbox to continue coding.'}
            </DialogDescription>
          </DialogHeader>
          {statusError ? <div className="space-y-2">
            <p role="alert" className="text-sm text-destructive">{statusError}</p>
            <Button disabled={restoring} size="sm" variant="outline" onClick={() => { setStatusError(undefined); setCheckVersion((version) => version + 1) }}>Retry status check</Button>
          </div> : null}
          {restoreError ? <p role="alert" className="text-sm text-destructive">{restoreError}</p> : null}
          {shutdown?.hasConflicts ? <p className="text-sm">Conflicting source versions were preserved. Use Review source to choose which version to restore.</p> : null}
          <p role="status" className="text-xs text-muted-foreground">
            {restorePhase === 'cancelling' ? 'Cancelling restoration and cleaning up the replacement…'
              : restorePhase === 'committing' ? 'Saving the restored workspace…'
              : restoring ? 'Creating a sandbox and restoring your saved files…'
              : 'Restoration copies saved source files only; dependencies and running servers are not saved.'}
          </p>
          <DialogFooter>
            {restoring
              ? <Button disabled={restorePhase !== 'restoring'} variant="ghost" onClick={cancelRestore}>Cancel restoration</Button>
              : <Button variant="ghost" onClick={() => setDismissed(true)}>Not now</Button>}
            <Button disabled={restoring} onClick={reopenRequired ? reopenProject : () => void restore()}>
              {restorePhase === 'cancelling' ? 'Cancelling…' : restorePhase === 'committing' ? 'Saving workspace…' : restoring ? 'Restoring…' : reopenRequired ? 'Reopen project' : restoreError ? 'Retry restoration' : 'Restore in a new sandbox'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
