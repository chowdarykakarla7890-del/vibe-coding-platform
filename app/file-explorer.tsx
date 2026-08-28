'use client'

import { FileExplorer as FileExplorerComponent } from '@/components/file-explorer/file-explorer'
import { useSandboxStore } from './state'
import { useLearning } from '@/lib/learning/learning-provider'
import { listFileSnapshots } from '@/lib/learning/db'
import { startProjectSandbox } from '@/lib/learning/sandbox-recovery'
import { cloudOperation } from '@/lib/learning/cloud-request'
import { useCallback } from 'react'

interface Props {
  className: string
}

export function FileExplorer({ className }: Props) {
  const { activeProject, updateProject } = useLearning()
  const projectId = activeProject?.id
  const registeredSandboxId = activeProject?.sandboxId
  const startWorkspace = useCallback(async (signal: AbortSignal) => {
    if (!projectId || registeredSandboxId) throw new Error('Reopen the project to check its workspace before creating another sandbox.')
    const account = cloudOperation(signal)
    await startProjectSandbox({
      projectId,
      signal: account.signal,
      loadFiles: signal => listFileSnapshots(projectId, signal),
      // The server already owns the association. Publishing its acknowledged
      // project receipt lets SnapshotObserver hydrate only the active project;
      // no late startup callback writes directly into the visible store.
      commit: sandboxId => updateProject(projectId, { sandboxId, previewUrl: undefined }),
    })
  }, [projectId, registeredSandboxId, updateProject])
  const {
    sandboxId,
    status,
    paths,
    addPaths,
    recordStudentEdit,
    setActiveFile,
    setDirtyFilePath,
    sourceUpdate,
    activeFile,
  } =
    useSandboxStore()
  return (
    <FileExplorerComponent
      key={projectId ?? 'no-project'}
      className={className}
      disabled={!projectId || status === 'stopped' || status === 'stopping' || registeredSandboxId !== sandboxId}
      sandboxId={sandboxId}
      paths={paths}
      initialSelectedPath={activeFile}
      sourceUpdate={sourceUpdate}
      onPathsCreated={addPaths}
      onDirtyPathChange={setDirtyFilePath}
      onSaved={recordStudentEdit}
      onSelectedPathChange={setActiveFile}
      onStartWorkspace={startWorkspace}
    />
  )
}
