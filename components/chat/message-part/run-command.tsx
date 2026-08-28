import type { DataPart } from '@/ai/messages/data-parts'
import { CheckIcon, SquareChevronRightIcon, XIcon } from 'lucide-react'
import { Spinner } from './spinner'
import { ToolHeader } from '../tool-header'
import { ToolMessage } from '../tool-message'

export function RunCommand({
  isStreaming,
  message,
}: {
  isStreaming: boolean
  message: DataPart['run-command']
}) {
  const commandLine = [message.command, ...message.args].join(' ')
  const interrupted =
    !isStreaming && ['executing', 'waiting'].includes(message.status)
  const failed =
    interrupted || message.status === 'error' || (message.exitCode ?? 0) > 0

  return (
    <ToolMessage>
      <ToolHeader>
        <SquareChevronRightIcon className="w-3.5 h-3.5" />
        {!interrupted && message.status === 'executing' && 'Executing'}
        {!interrupted && message.status === 'waiting' && 'Waiting'}
        {message.status === 'running' && 'Running in background'}
        {message.status === 'done' && !failed && 'Finished'}
        {message.status === 'done' && failed && 'Errored'}
        {message.status === 'error' && 'Errored'}
        {interrupted && 'Interrupted'}
      </ToolHeader>
      <div className="relative pl-6">
        <Spinner
          className="absolute left-0 top-0"
          loading={
            isStreaming && ['executing', 'waiting'].includes(message.status)
          }
        >
          {failed ? (
            <XIcon className="w-4 h-4 text-red-700" />
          ) : (
            <CheckIcon className="w-4 h-4" />
          )}
        </Spinner>
        <code className="block whitespace-pre-wrap break-words text-xs text-foreground">
          {commandLine}
        </code>
        {(message.error?.message || interrupted) && (
          <p className="mt-1.5 text-xs leading-4 text-red-400">
            {message.error?.message ??
              'This command did not finish. Start a new sandbox and try again.'}
          </p>
        )}
      </div>
    </ToolMessage>
  )
}
