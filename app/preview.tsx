'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Preview as PreviewComponent } from '@/components/preview/preview'
import { useLearning } from '@/lib/learning/learning-provider'
import { cloudOperation } from '@/lib/learning/cloud-request'
import { previewReceiptSchema, type PreviewReceipt } from '@/lib/sandbox/preview'
import { useSandboxStore } from './state'

export function Preview({ className }: { className?: string }) {
  const { activeProject } = useLearning()
  const sandboxId = useSandboxStore(state => state.sandboxId)
  if (!activeProject || !sandboxId || activeProject.sandboxId !== sandboxId) {
    return <PreviewComponent className={className} />
  }
  return <OwnedPreview key={`${activeProject.id}:${sandboxId}`} projectId={activeProject.id} sandboxId={sandboxId} className={className} />
}

function OwnedPreview({ projectId, sandboxId, className }: { projectId: string; sandboxId: string; className?: string }) {
  const status = useSandboxStore(state => state.status)
  const urlVersion = useSandboxStore(state => state.urlUUID)
  const disabled = status !== 'running'
  const pending = useRef<AbortController | null>(null)
  const [state, setState] = useState<{ preview?: PreviewReceipt; loading: boolean; error?: string; version: number }>({ loading: true, version: 0 })

  const connect = useCallback(async (port?: number, save = false) => {
    pending.current?.abort()
    if (disabled) return
    const controller = new AbortController()
    pending.current = controller
    setState(previous => ({ ...previous, loading: true, error: undefined }))
    try {
      const operation = cloudOperation(controller.signal)
      const endpoint = `/api/sandboxes/${encodeURIComponent(sandboxId)}/preview`
      const query = new URLSearchParams({ projectId, ...(port === undefined ? {} : { port: String(port) }) })
      const preview = await operation.request(save ? endpoint : `${endpoint}?${query}`, previewReceiptSchema,
        save ? 'POST' : 'GET', save ? { projectId, port } : undefined)
      operation.assertActive()
      if (preview.projectId !== projectId || preview.sandboxId !== sandboxId) throw new Error('The preview belongs to a different workspace. Reconnect to this project.')
      const current = useSandboxStore.getState()
      if (current.sandboxId !== sandboxId || current.status !== 'running') return
      setState(previous => ({ preview, loading: false, version: previous.version + 1 }))
    } catch (error) {
      if (!controller.signal.aborted) setState(previous => ({ ...previous, loading: false, error: error instanceof Error ? error.message : 'Could not connect to the sandbox preview.' }))
    } finally {
      if (pending.current === controller) pending.current = null
    }
  }, [disabled, projectId, sandboxId])

  useEffect(() => {
    // Revalidate an AI-provided/cached URL against the owned VM; never load it
    // directly. Every project switch or expiry cancels the obsolete request.
    void connect()
    return () => pending.current?.abort()
  }, [connect, urlVersion])

  return <PreviewComponent
    key={state.version}
    className={className}
    disabled={disabled}
    url={state.preview?.url}
    loading={state.loading && !disabled}
    error={disabled ? undefined : state.error}
    ports={state.preview?.ports}
    port={state.preview?.port}
    onPortChange={port => void connect(port, true)}
    onReconnect={() => void connect(state.preview?.port)}
  />
}
