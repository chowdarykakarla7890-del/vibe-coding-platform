import type { DataPart } from '@/ai/messages/data-parts'
import { BoxIcon, CheckIcon, XIcon } from 'lucide-react'
import { Spinner } from './spinner'
import { ToolHeader } from '../tool-header'
import { ToolMessage } from '../tool-message'

interface Props {
  isStreaming: boolean
  message: DataPart['create-sandbox']
}

export function CreateSandbox({ isStreaming, message }: Props) {
  const interrupted = !isStreaming && message.status === 'loading'
  const failed = message.status === 'error' || interrupted
  return (
    <ToolMessage>
      <ToolHeader>
        <BoxIcon className="w-3.5 h-3.5" />
        Create Sandbox
      </ToolHeader>
      <div className="relative pl-6 min-h-5">
        <Spinner
          className="absolute left-0 top-0"
          loading={isStreaming && message.status === 'loading'}
        >
          {failed ? (
            <XIcon className="w-4 h-4 text-red-700" />
          ) : (
            <CheckIcon className="w-4 h-4" />
          )}
        </Spinner>
        <span>
          {message.status === 'done' && 'Sandbox created successfully'}
          {!interrupted && message.status === 'loading' && 'Creating Sandbox'}
          {message.status === 'error' && 'Failed to create sandbox'}
          {interrupted && 'Sandbox creation was interrupted'}
        </span>
        {(message.error?.message || interrupted) && (
          <p className="mt-1.5 text-xs leading-4 text-red-400">
            {message.error?.message ?? 'Create a new sandbox and try again.'}
          </p>
        )}
      </div>
    </ToolMessage>
  )
}
