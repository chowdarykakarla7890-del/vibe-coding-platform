'use client'

import { Button } from '@/components/ui/button'
import { Loader } from '@/components/ai-elements/loader'
import type { ChatUIMessage } from '@/components/chat/types'
import { cn } from '@/lib/utils'
import type { ChatStatus } from 'ai'
import {
  BotIcon,
  RotateCcwIcon,
  SquareIcon,
} from 'lucide-react'

export function hasCurrentAssistantOutput(messages: ChatUIMessage[]) {
  const lastMessage = messages.at(-1)
  if (lastMessage?.role !== 'assistant') return false

  return lastMessage.parts.some((part) => {
    switch (part.type) {
      case 'text':
      case 'reasoning':
        return part.text.trim().length > 0
      case 'tool-readFiles':
      case 'data-generating-files':
      case 'data-create-sandbox':
      case 'data-get-sandbox-url':
      case 'data-run-command':
      case 'data-report-errors':
        return true
      default:
        return false
    }
  })
}

export function ChatProgress({
  hasAssistantOutput,
  interrupted,
  modelName,
  operation,
  recoveryError,
  onRetry,
  onStop,
  stalled,
  status,
}: {
  hasAssistantOutput: boolean
  interrupted: boolean
  modelName: string
  operation?: 'stopping' | 'reconnecting'
  recoveryError?: string
  onRetry: () => void
  onStop: () => void
  stalled: boolean
  status: ChatStatus
}) {
  const isActive = status === 'submitted' || status === 'streaming'

  if (operation) {
    return <div className="mr-5 flex min-h-10 items-center gap-2 rounded-md border border-border px-3 py-2 font-mono text-xs text-muted-foreground" aria-busy="true">
      <div role="status" aria-live="polite" className="flex min-w-0 flex-1 items-center gap-2">
        <Loader aria-hidden="true" className="shrink-0 motion-reduce:animate-none" size={13} />
        {operation === 'stopping' ? 'Stopping and checking saved response…' : 'Reconnecting to saved response…'}
      </div>
      <StopButton onStop={onStop} disabled />
    </div>
  }

  if (isActive) {
    return (
      <div
        className={cn(
          'mr-5 overflow-hidden motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-300',
          'transition-[min-height] duration-500 ease-out motion-reduce:transition-none',
          hasAssistantOutput ? 'min-h-9' : 'min-h-[68px]'
        )}
        data-state={hasAssistantOutput ? 'working' : 'planning'}
      >
        <div
          aria-hidden={hasAssistantOutput}
          className={cn(
            'grid transition-[grid-template-rows,opacity,margin] duration-500 ease-out motion-reduce:transition-none',
            hasAssistantOutput
              ? 'mb-0 grid-rows-[0fr] opacity-0'
              : 'mb-1.5 grid-rows-[1fr] opacity-100'
          )}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="flex items-center gap-2 font-mono text-sm font-medium text-primary">
              <BotIcon className="size-4" />
              <span>Assistant ({modelName})</span>
            </div>
          </div>
        </div>

        <div
          className={cn(
            'flex items-center gap-2 rounded-md border font-mono text-xs text-muted-foreground',
            'transition-[min-height,padding,background-color,border-color] duration-500 ease-out motion-reduce:transition-none',
            hasAssistantOutput
              ? 'min-h-9 border-transparent bg-transparent px-3 py-1.5'
              : 'min-h-10 border-border bg-secondary/50 px-3 py-2'
          )}
        >
          <div
            aria-live="polite"
            className="flex min-w-0 flex-1 items-center gap-2"
            role="status"
          >
            <Loader
              aria-hidden="true"
              className="shrink-0 text-zinc-400 [animation-duration:1.35s] motion-reduce:animate-none"
              size={hasAssistantOutput ? 13 : 14}
            />
            <span className="sr-only">
              {hasAssistantOutput ? 'Tutor is working…' : 'Tutor is planning…'}
            </span>
            <span
              aria-hidden="true"
              className="relative min-h-4 min-w-0 flex-1 overflow-hidden"
            >
              <span
                className={cn(
                  'absolute inset-0 transition-[opacity,transform] duration-300 ease-out motion-reduce:transform-none motion-reduce:transition-none',
                  hasAssistantOutput
                    ? '-translate-y-1 opacity-0'
                    : 'translate-y-0 opacity-100'
                )}
              >
                Tutor is planning…
              </span>
              <span
                className={cn(
                  'absolute inset-0 transition-[opacity,transform] duration-300 ease-out motion-reduce:transform-none motion-reduce:transition-none',
                  hasAssistantOutput
                    ? 'translate-y-0 opacity-100'
                    : 'translate-y-1 opacity-0'
                )}
              >
                Tutor is working…
              </span>
            </span>
          </div>
          <StopButton onStop={onStop} />
        </div>
      </div>
    )
  }

  if (!(recoveryError || stalled || interrupted || status === 'error')) return null

  return (
    <div
      aria-live="assertive"
      className="flex items-center gap-2 rounded-md border border-amber-900/60 bg-amber-950/20 px-3 py-2 font-mono text-xs text-amber-200"
    >
      <span className="min-w-0 flex-1">
        {recoveryError ?? (stalled
          ? 'The tutor stopped after 90 seconds without progress.'
          : interrupted
            ? 'Generation was stopped before it finished.'
            : 'The tutor could not finish this response.')}
      </span>
      <Button
        className="h-7 gap-1.5 px-2 text-xs"
        onClick={onRetry}
        type="button"
        variant="outline"
      >
        <RotateCcwIcon className="size-3" />
        Retry
      </Button>
    </div>
  )
}

function StopButton({ onStop, disabled }: { onStop: () => void; disabled?: boolean }) {
  return (
    <Button
      aria-label="Stop tutor response"
      className="h-7 gap-1.5 px-2 text-xs"
      onClick={onStop}
      disabled={disabled}
      type="button"
      variant="outline"
    >
      <SquareIcon className="size-3" />
      Stop
    </Button>
  )
}
