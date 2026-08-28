'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useSandboxStore } from '@/app/state'
import { useLearning } from '@/lib/learning/learning-provider'
import { requestSandboxShutdown } from '@/lib/learning/sandbox-recovery'
import { toast } from 'sonner'

export function SandboxStop() {
  const { activeProject } = useLearning()
  const sandboxId = useSandboxStore(state => state.sandboxId)
  const status = useSandboxStore(state => state.status)
  if (!activeProject || !sandboxId || activeProject.sandboxId !== sandboxId || status !== 'running') return null
  return <StopButton key={`${activeProject.id}:${sandboxId}`} sandboxId={sandboxId} />
}

function StopButton({ sandboxId }: { sandboxId: string }) {
  const [pending, setPending] = useState(false)
  const request = useRef<AbortController | null>(null)
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current?.abort() } }, [])

  async function stop() {
    if (request.current) return
    if (useSandboxStore.getState().dirtyFilePath) {
      toast.error('Save or copy your unsaved editor draft before stopping the sandbox.')
      return
    }
    if (!window.confirm('Stop this sandbox? Running programs will stop, and supported source files will be saved before the sandbox shuts down.')) return
    const controller = new AbortController()
    request.current = controller
    setPending(true)
    try {
      await requestSandboxShutdown(sandboxId, controller.signal)
      if (!controller.signal.aborted) {
        // The recovery panel fetches the authoritative final receipt, including
        // when an idempotent Stop response says the VM has already ended.
        useSandboxStore.getState().setSandboxStatus(sandboxId, 'stopping')
      }
    } catch (error) {
      if (!controller.signal.aborted) toast.error(error instanceof Error ? error.message : 'Shutdown could not be confirmed. Check its status before retrying.')
    } finally {
      if (request.current === controller) request.current = null
      if (mounted.current) setPending(false)
    }
  }
  return <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={pending} onClick={() => void stop()}>{pending ? 'Requesting stop…' : 'Stop sandbox'}</Button>
}
