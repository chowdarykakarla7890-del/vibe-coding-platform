import type { DataPart } from '@/ai/messages/data-parts'
import { CheckIcon, LinkIcon, XIcon } from 'lucide-react'
import { Spinner } from './spinner'
import { ToolHeader } from '../tool-header'
import { ToolMessage } from '../tool-message'

export function GetSandboxURL({
  isStreaming,
  message,
}: {
  isStreaming: boolean
  message: DataPart['get-sandbox-url']
}) {
  const interrupted = !isStreaming && message.status === 'loading'
  const failed = message.status === 'error' || interrupted

  return (
    <ToolMessage>
      <ToolHeader>
        <LinkIcon className="w-3.5 h-3.5" />
        <span>Get Sandbox URL</span>
      </ToolHeader>
      <div className="relative pl-6 min-h-5">
        <Spinner
          className="absolute left-0 top-0"
          loading={isStreaming && message.status === 'loading'}
        >
          {failed ? (
            <XIcon className="size-4 text-red-500" />
          ) : (
            <CheckIcon className="size-4" />
          )}
        </Spinner>
        {failed ? (
          <span className="text-red-400">
            {message.error?.message ??
              'The sandbox URL request was interrupted. Try again.'}
          </span>
        ) : message.url ? (
          <a href={message.url} rel="noopener noreferrer" target="_blank">
            {message.url}
          </a>
        ) : (
          <span>Getting Sandbox URL</span>
        )}
      </div>
    </ToolMessage>
  )
}
