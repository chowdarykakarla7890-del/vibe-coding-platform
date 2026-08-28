import { APICallError, RetryError } from 'ai'
import { GatewayError } from '@ai-sdk/gateway'

/** Safe operator codes and user guidance. Never expose provider messages,
 * response bodies, request arguments or credential-bearing URLs. In particular,
 * the Gateway currently wraps HTTP 402 as GatewayInternalServerError, so its
 * name alone cannot distinguish an outage from exhausted service credits.
 */
export function getAIServiceFailure(error: unknown): {
  code: string
  status: 502 | 503
  upstreamStatus?: number
  message: string
} | undefined {
  let cause = error
  for (let depth = 0; depth < 4 && RetryError.isInstance(cause); depth++) cause = cause.lastError
  if (!GatewayError.isInstance(cause) && !APICallError.isInstance(cause)) return undefined
  const upstreamStatus = cause.statusCode
  const gatewayType = GatewayError.isInstance(cause) ? cause.type : undefined
  if (upstreamStatus === 402) return {
    code: 'AI_CREDITS_EXHAUSTED', status: 503, upstreamStatus,
    message: 'The AI service is out of credits. The service owner needs to restore its balance before you retry.',
  }
  if (upstreamStatus === 401 || upstreamStatus === 403) return {
    code: 'AI_CONFIGURATION_ERROR', status: 503, upstreamStatus,
    message: 'The AI service could not authenticate. Please contact the service owner; signing in again will not fix this.',
  }
  if (upstreamStatus === 404 || gatewayType === 'model_not_found') return {
    code: 'AI_MODEL_UNAVAILABLE', status: 503, upstreamStatus,
    message: 'This AI model is currently unavailable. Choose another supported model.',
  }
  if (upstreamStatus === 429) return {
    code: 'AI_PROVIDER_RATE_LIMITED', status: 503, upstreamStatus,
    message: 'The AI provider is temporarily at capacity. Try again shortly.',
  }
  return {
    code: 'AI_UPSTREAM_UNAVAILABLE', status: 502, upstreamStatus,
    message: 'The AI service could not complete this request. Please try again later.',
  }
}
