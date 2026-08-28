'use client'

import { CommandsLogs } from '@/components/commands-logs/commands-logs'
import { useSandboxStore } from './state'
import { toast } from 'sonner'
import { getApiErrorMessage } from '@/lib/api-error'
import { useEffect, useRef } from 'react'
import { cloudOperation } from '@/lib/learning/cloud-request'
import { z } from 'zod'
import type { Command } from '@/components/commands-logs/types'

const startResponse = z.object({ cmdId: z.string().min(1), sandboxId: z.string(), background: z.boolean() })

export function Logs(props: { className?: string }) {
  const { commands, sandboxId, status, upsertCommand } = useSandboxStore()
  const pending = useRef(new Set<AbortController>())
  useEffect(() => {
    const requests = pending.current
    return () => { for (const controller of requests) controller.abort(); requests.clear() }
  }, [sandboxId])

  const runCommand = async (command: string, background: boolean) => {
    if (!sandboxId) return false
    const controller = new AbortController()
    pending.current.add(controller)
    try {
    const operation = cloudOperation()
    const response = await operation.fetch(`/api/sandboxes/${encodeURIComponent(sandboxId)}/terminal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, background }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(35_000)]),
    })
    const result: unknown = await response.json().catch(() => undefined)
    operation.assertActive()
    if (controller.signal.aborted || useSandboxStore.getState().sandboxId !== sandboxId) return false
    if (!response.ok) {
      toast.error(getApiErrorMessage(result, 'Unable to run command'))
      return false
    }
    const parsed = startResponse.safeParse(result)
    if (!parsed.success || parsed.data.sandboxId !== sandboxId) {
      toast.error('The terminal returned an invalid response.')
      return false
    }
    upsertCommand({
      sandboxId,
      cmdId: parsed.data.cmdId,
      command,
      args: [],
      background,
      status: 'running',
    })
    return true
    } catch {
      if (!controller.signal.aborted && useSandboxStore.getState().sandboxId === sandboxId) toast.error('Command start was interrupted. Check existing output before retrying.')
      return false
    } finally { pending.current.delete(controller) }
  }

  const stopCommand = async (command: Command) => {
    const controller = new AbortController()
    pending.current.add(controller)
    try {
      const operation = cloudOperation()
      const response = await operation.fetch(`/api/sandboxes/${encodeURIComponent(command.sandboxId)}/cmds/${encodeURIComponent(command.cmdId)}`, { method: 'DELETE', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) })
      const result: unknown = await response.json().catch(() => undefined)
      operation.assertActive()
      if (controller.signal.aborted || useSandboxStore.getState().sandboxId !== command.sandboxId) return
      if (!response.ok) { toast.error(getApiErrorMessage(result, 'Unable to stop command')); return }
      if (!z.object({ stopped: z.literal(true) }).safeParse(result).success) { toast.error('Invalid command stop response.'); return }
      // Only update the outcome. Output may have arrived while Stop was pending.
      upsertCommand({ sandboxId: command.sandboxId, cmdId: command.cmdId, command: command.command, args: command.args, status: 'done' })
    } catch {
      if (!controller.signal.aborted) toast.error('Command stop could not be confirmed. Retry Stop.')
    } finally { pending.current.delete(controller) }
  }

  return (
    <CommandsLogs
      key={sandboxId ?? 'no-sandbox'}
      className={props.className}
      commands={commands}
      disabled={!sandboxId || status === 'stopped' || status === 'stopping'}
      onRunCommand={runCommand}
      onStopCommand={stopCommand}
      onRetryLogs={(command) => upsertCommand({ sandboxId: command.sandboxId, cmdId: command.cmdId, command: command.command, args: command.args, logError: undefined })}
    />
  )
}
