'use client'

import { useSandboxStore } from '@/app/state'
import { listFileSnapshots } from '@/lib/learning/db'
import { useLearning } from '@/lib/learning/learning-provider'
import { readWithDeadline } from '@/lib/abortable-read'
import { Button } from '@/components/ui/button'
import { useEffect, useState } from 'react'

export function ProjectSandboxSync() {
  const { activeProject } = useLearning()
  const [loadError, setLoadError] = useState<string>()
  const [retryVersion, setRetryVersion] = useState(0)
  const projectId = activeProject?.id
  const sandboxId = activeProject?.sandboxId
  const previewUrl = activeProject?.previewUrl
  const workspaceKey = projectId && sandboxId ? `${projectId}:${sandboxId}` : undefined

  useEffect(() => {
    const state = useSandboxStore.getState()
    if (!projectId || !sandboxId) {
      if (state.sandboxId) state.clearSandbox()
      return
    }
    const controller = new AbortController()
    // Attaching the same ID is idempotent. Still load paths: a previous effect
    // may have been cancelled by Strict Mode or a restore may have attached it
    // before this component mounted.
    state.setSandboxId(sandboxId)
    void readWithDeadline((signal) => listFileSnapshots(projectId, signal), controller.signal, 10_000,
      'Opening saved source files timed out.').then((files) => {
      const current = useSandboxStore.getState()
      if (!controller.signal.aborted && current.sandboxId === sandboxId) {
        current.addPaths(files.map((file) => file.path))
        setLoadError(undefined)
      }
    }).catch((error) => {
      if (controller.signal.aborted) return
      setLoadError(`${projectId}:${sandboxId}`)
      console.warn('Could not load saved source paths', {
        errorName: error instanceof Error ? error.name : 'StorageError',
      })
    })
    return () => controller.abort()
  }, [projectId, sandboxId, retryVersion])

  useEffect(() => {
    const current = useSandboxStore.getState()
    if (sandboxId && current.sandboxId === sandboxId && previewUrl && current.url !== previewUrl) {
      current.setUrl(previewUrl, `saved-preview:${sandboxId}`)
    }
  }, [projectId, sandboxId, previewUrl])

  if (!workspaceKey || loadError !== workspaceKey) return null
  return <aside role="alert" className="fixed bottom-4 left-4 z-40 max-w-sm rounded-lg border border-border bg-card p-4 text-sm shadow-lg">
    <p>Saved files could not be opened. Your source snapshots have not been changed.</p>
    <Button className="mt-3" size="sm" variant="outline" onClick={() => { setLoadError(undefined); setRetryVersion((version) => version + 1) }}>Retry loading files</Button>
  </aside>
}
