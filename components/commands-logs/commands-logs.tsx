'use client'

import type { Command } from './types'
import { Panel, PanelHeader } from '@/components/panels/panels'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PlayIcon, TerminalIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

interface Props {
  className?: string
  commands: Command[]
  disabled?: boolean
  onRunCommand?: (command: string, background: boolean) => Promise<boolean>
  onRetryLogs?: (command: Command) => void
  onStopCommand?: (command: Command) => Promise<void>
}

export function CommandsLogs(props: Props) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const [command, setCommand] = useState('')
  const [running, setRunning] = useState(false)
  const [background, setBackground] = useState(false)
  const [stopping, setStopping] = useState<Set<string>>(() => new Set())
  const [error, setError] = useState<string>()

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'auto' })
  }, [props.commands])

  return (
    <Panel className={props.className}>
      <PanelHeader>
        <TerminalIcon className="mr-2 w-4 text-zinc-400" />
        <span className="font-mono uppercase font-semibold">
          Student terminal
        </span>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          sandbox shell
        </span>
      </PanelHeader>
      <div className="min-h-0 flex-1 bg-[#0d1117] text-zinc-200">
        <ScrollArea className="h-full">
          <div className="p-2 space-y-2">
            {props.commands.length === 0 && (
              <div className="font-mono text-xs leading-5 text-zinc-500">
                Run your code, tests, lint, or build here.
                <br />Try <span className="text-zinc-300">pnpm test</span> or{' '}
                <span className="text-zinc-300">pnpm build</span>.
              </div>
            )}
            {props.commands.map((command) => {
              const date = new Date(command.startedAt).toLocaleTimeString(
                'en-US',
                {
                  hour12: false,
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                }
              )

              const line = `${command.command} ${command.args.join(' ')}`
              const body = command.logs?.map((log) => log.data).join('') || ''
              return (
                <pre
                  key={command.cmdId}
                  className="whitespace-pre-wrap font-mono text-sm"
                >
                  <span className="text-zinc-500">[{date}]</span>{' '}
                  <span className="text-zinc-300">$ {line}</span>
                  {command.status === 'running' && props.onStopCommand && <button type="button" disabled={stopping.has(command.cmdId)} aria-label={`Stop ${line}`} className="ml-2 text-xs underline focus-visible:outline disabled:opacity-50" onClick={async () => {
                    if (stopping.has(command.cmdId)) return
                    setStopping((current) => new Set(current).add(command.cmdId))
                    setError(undefined)
                    try { await props.onStopCommand?.(command) }
                    catch { setError('Could not stop this command. Please retry.') }
                    finally { setStopping((current) => { const next = new Set(current); next.delete(command.cmdId); return next }) }
                  }}>{stopping.has(command.cmdId) ? 'Stopping…' : 'Stop'}</button>}
                  {`\n${body}`}
                  {command.logsTruncated && <span className="block text-xs text-zinc-400">Earlier output omitted; only the recent output is kept.</span>}
                  {command.logError && <span className="block text-xs text-zinc-400" role="status">
                    {command.logError}{' '}
                    {!command.logsComplete && <button className="underline focus-visible:outline focus-visible:outline-1" type="button" onClick={() => props.onRetryLogs?.(command)} aria-label={`Retry logs for ${line}`}>Retry output</button>}
                  </span>}
                  {command.error && (
                    <span className="block text-red-400">{command.error}</span>
                  )}
                </pre>
              )
            })}
          </div>
          <div ref={bottomRef} />
        </ScrollArea>
      </div>
      {error && <p className="px-2 text-xs text-red-400" role="alert">{error}</p>}
      <form
        className="flex items-center gap-2 border-t border-white/10 bg-[#161b22] p-2"
        onSubmit={async (event) => {
          event.preventDefault()
          if (props.disabled || running || !command.trim() || !props.onRunCommand) return
          setRunning(true)
          setError(undefined)
          try {
            if (await props.onRunCommand(command.trim(), background)) setCommand('')
          } catch {
            setError('Command start failed. Your input has been kept.')
          } finally {
            setRunning(false)
          }
        }}
      >
        <span className="pl-1 font-mono text-sm text-zinc-300">$</span>
        <Input
          aria-label="Terminal command"
          className="h-8 flex-1 border-0 bg-transparent font-mono text-xs text-zinc-100 shadow-none placeholder:text-zinc-600 focus-visible:ring-0"
          disabled={props.disabled || running}
          onChange={(event) => setCommand(event.target.value)}
          placeholder={props.disabled ? 'Start a lesson to open a sandbox' : 'Type a command…'}
          value={command}
        />
        <select aria-label="Command execution mode" title="60 sec for commands; Server runs until the sandbox expires" className="max-w-20 rounded border border-white/10 bg-transparent text-xs text-zinc-300" disabled={running || props.disabled} value={background ? 'server' : 'foreground'} onChange={(event) => setBackground(event.target.value === 'server')}>
          <option value="foreground">60 sec</option>
          <option value="server">Server</option>
        </select>
        <Button
          className="h-8 bg-zinc-100 px-2.5 text-zinc-900 hover:bg-zinc-300"
          disabled={props.disabled || running || !command.trim()}
          size="sm"
          type="submit"
        >
          <PlayIcon className="size-3.5" />
          <span className="sr-only">Run command</span>
        </Button>
      </form>
    </Panel>
  )
}
