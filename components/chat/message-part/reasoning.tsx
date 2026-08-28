import type { ReasoningUIPart } from 'ai'
import { MessageSpinner } from '../message-spinner'
import { useReasoningContext } from '../message'
import { Streamdown } from 'streamdown'
import { ChevronDownIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export function Reasoning({
  part,
  partIndex,
}: {
  part: ReasoningUIPart
  partIndex: number
}) {
  const context = useReasoningContext()
  const isExpanded = context?.expandedReasoningIndex === partIndex

  if (part.state === 'done' && !part.text) {
    return null
  }

  const text = part.text || '_Thinking_'
  const isStreaming = part.state === 'streaming'
  const firstLine = text.split('\n')[0].replace(/\*\*/g, '')
  const hasMoreContent = text.includes('\n') || text.length > 80

  const handleClick = () => {
    if (hasMoreContent && context) {
      const newIndex = isExpanded ? null : partIndex
      context.setExpandedReasoningIndex(newIndex)
    }
  }

  return (
    <div className="rounded-md border border-border bg-background text-sm">
      {hasMoreContent ? (
        <button
          aria-expanded={isExpanded}
          className="flex w-full items-center gap-2 px-3 py-2 text-left font-mono text-secondary-foreground transition-colors hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={handleClick}
          type="button"
        >
          <span className="min-w-0 flex-1 truncate">{firstLine}</span>
          <ChevronDownIcon
            aria-hidden="true"
            className={cn(
              'size-3.5 shrink-0 transition-transform',
              isExpanded && 'rotate-180'
            )}
          />
          <span className="sr-only">
            {isExpanded ? 'Collapse reasoning' : 'Expand reasoning'}
          </span>
        </button>
      ) : null}
      {isExpanded || !hasMoreContent ? (
        <div className={cn('px-3 py-2', hasMoreContent && 'border-t border-border')}>
          <div className="font-mono leading-normal text-secondary-foreground">
            <Streamdown>{text}</Streamdown>
            {isStreaming && <MessageSpinner />}
          </div>
        </div>
      ) : null}
    </div>
  )
}
