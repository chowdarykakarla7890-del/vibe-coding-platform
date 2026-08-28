import { ApiError } from '@/lib/server/api'
import { getSandboxErrorCode, isSandboxUnavailableError } from '@/ai/sandbox'
import { getAIServiceFailure } from '@/ai/service-error'

interface Params {
  args?: Record<string, unknown>
  action: string
  error: unknown
}

/**
 * Tool errors are sent to the browser and model. Never forward raw upstream
 * bodies, stacks, request arguments, source files, or credential-bearing URLs.
 */
export function getRichError({ action, error }: Params) {
  const message = error instanceof ApiError ? error.message
    : getAIServiceFailure(error)?.message ?? (isSandboxUnavailableError(error) ? 'This sandbox expired. Restore the project before continuing.'
      : error instanceof Error && error.name === 'AbortError' ? 'The operation was stopped.'
        : error instanceof Error && error.name === 'TimeoutError' ? 'The operation timed out. Please retry.'
          : getSandboxErrorCode(error) === 'rate_limit_exceeded' ? 'The sandbox is temporarily rate limited. Try again shortly.'
            : 'The service could not complete this operation. Please retry.')
  return { message: `Error during ${action}: ${message}`, error: { message } }
}
