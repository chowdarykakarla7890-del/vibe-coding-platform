import type { ChatUIMessage } from '@/components/chat/types'
import { CheckIcon, EyeIcon, Loader2Icon, XIcon } from 'lucide-react'
import { ToolHeader } from '../tool-header'
import { ToolMessage } from '../tool-message'

type ReadFilesPart = Extract<
  ChatUIMessage['parts'][number],
  { type: 'tool-readFiles' }
>

export function ReadFiles({
  isStreaming,
  part,
}: {
  isStreaming: boolean
  part: ReadFilesPart
}) {
  const paths = 'input' in part ? (part.input?.paths ?? []) : []
  const complete = part.state === 'output-available'
  const interrupted =
    !isStreaming && !complete && part.state !== 'output-error'
  const failed = part.state === 'output-error' || interrupted

  return (
    <ToolMessage>
      <ToolHeader>
        {failed ? (
          <XIcon className="size-3.5 text-red-600" />
        ) : complete ? (
          <CheckIcon className="size-3.5 text-zinc-300" />
        ) : (
          <Loader2Icon className="size-3.5 animate-spin text-zinc-400" />
        )}
        <EyeIcon className="size-3.5" />
        <span>
          {complete
            ? 'Reviewed student code'
            : failed
              ? 'Could not read current files'
              : 'Reading current files'}
        </span>
      </ToolHeader>
      {interrupted && (
        <p className="mt-1.5 text-xs leading-4 text-red-400">
          The file read was interrupted. Try the request again.
        </p>
      )}
      {paths.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {paths.map((path) => (
            <code
              className="rounded border border-border bg-secondary px-1.5 py-0.5 text-[11px]"
              key={path}
            >
              {path}
            </code>
          ))}
        </div>
      )}
    </ToolMessage>
  )
}
