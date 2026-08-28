'use client'

import { useEffect, useRef } from 'react'
import { useSandboxStore } from '@/app/state'
import { followCommandLogs } from '@/lib/commands/follow-logs'
import { CommandOutputError } from './api'

export function CommandLogsStream() {
  const { sandboxId, status, commands, addLog, upsertCommand } = useSandboxStore()
  const subscriptions = useRef(new Map<string, AbortController>())
  useEffect(() => {
    // Process completion and draining its remaining output are separate states.
    // A fast command/tool can finish before the first log subscriber mounts.
    const pending = sandboxId && status !== 'stopped' && status !== 'stopping'
      ? commands.filter((command) => !command.logsComplete && !command.logError) : []
    const activeKeys = new Set(pending.map((command) => `${sandboxId}:${command.cmdId}`))
    for (const [key, controller] of subscriptions.current) {
      if (!activeKeys.has(key)) { controller.abort(); subscriptions.current.delete(key) }
    }
    if (!sandboxId) return
    for (const command of pending) {
      const key = `${sandboxId}:${command.cmdId}`
      if (subscriptions.current.has(key) || subscriptions.current.size >= 3) continue
      const controller = new AbortController()
      subscriptions.current.set(key, controller)
      const identity = { sandboxId, cmdId: command.cmdId, command: command.command, args: command.args }
      void followCommandLogs({
        sandboxId, cmdId: command.cmdId, cursor: command.logCursor, signal: controller.signal,
        onRecord: (record) => {
          if (controller.signal.aborted) return
          if (record.type === 'log') addLog({ sandboxId, cmdId: command.cmdId, cursor: record.cursor, log: {
            data: record.data, stream: record.stream, timestamp: record.timestamp,
          } })
          else if (record.type === 'status' && record.status === 'done') {
            upsertCommand({ ...identity, exitCode: record.exitCode ?? undefined, status: 'done', logsComplete: true, logError: undefined })
          } else if (record.type === 'status' && record.status === 'expired') {
            upsertCommand({ ...identity, logsComplete: true, logError: 'This command output expired. Run the command again.' })
          }
        },
      }).catch((error) => {
        if (controller.signal.aborted) return
        upsertCommand({ ...identity, logError: error instanceof CommandOutputError ? error.message : 'The command output could not be loaded. Retry to reconnect.' })
      }).finally(() => {
        if (subscriptions.current.get(key) === controller) subscriptions.current.delete(key)
      })
    }
  }, [sandboxId, status, commands, addLog, upsertCommand])
  useEffect(() => {
    const active = subscriptions.current
    return () => { for (const controller of active.values()) controller.abort(); active.clear() }
  }, [])
  return null
}
