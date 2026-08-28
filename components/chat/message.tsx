import type { ChatUIMessage } from './types'
import { MessagePart } from './message-part'
import { BotIcon, UserIcon } from 'lucide-react'
import { memo, createContext, useContext, useState } from 'react'
import { cn } from '@/lib/utils'

interface Props {
  isStreaming?: boolean
  message: ChatUIMessage
}

interface ReasoningContextType {
  expandedReasoningIndex: number | null
  setExpandedReasoningIndex: (index: number | null) => void
}

const ReasoningContext = createContext<ReasoningContextType | null>(null)

export const useReasoningContext = () => {
  const context = useContext(ReasoningContext)
  return context
}

export const Message = memo(function Message({ isStreaming = false, message }: Props) {
  const [expandedReasoningIndex, setExpandedReasoningIndex] = useState<
    number | null | undefined
  >(undefined)

  const reasoningParts = message.parts
    .map((part, index) => ({ part, index }))
    .filter(({ part }) => part.type === 'reasoning')

  const latestReasoningIndex = reasoningParts.at(-1)?.index ?? null
  const visibleReasoningIndex =
    expandedReasoningIndex === undefined
      ? latestReasoningIndex
      : expandedReasoningIndex

  return (
    <ReasoningContext.Provider
      value={{
        expandedReasoningIndex: visibleReasoningIndex,
        setExpandedReasoningIndex,
      }}
    >
      <div
        className={cn({
          'mr-5': message.role === 'assistant',
          'ml-5': message.role === 'user',
        })}
      >
        {/* Message Header */}
        <div className="flex items-center gap-2 text-sm font-medium font-mono text-primary mb-1.5">
          {message.role === 'user' ? (
            <>
              <UserIcon className="ml-auto w-4" />
              <span>You</span>
            </>
          ) : (
            <>
              <BotIcon className="w-4" />
              <span>Assistant ({message.metadata?.model})</span>
            </>
          )}
        </div>

        {/* Message Content */}
        <div className="space-y-1.5">
          {!isStreaming && message.metadata?.persistenceStatus && message.metadata.persistenceStatus !== 'complete' ? (
            <p className="text-xs text-muted-foreground" role="status">{message.metadata.persistenceStatus === 'pending' ? 'Response in progress…' : message.metadata.persistenceStatus === 'failed' ? 'This response failed. You can retry it.' : 'This response was interrupted. You can retry it.'}</p>
          ) : null}
          {message.parts.map((part, index) => (
            <MessagePart
              isStreaming={isStreaming}
              key={index}
              part={part}
              partIndex={index}
            />
          ))}
        </div>
      </div>
    </ReasoningContext.Provider>
  )
})
