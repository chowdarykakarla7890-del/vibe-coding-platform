import 'server-only'
import { z } from 'zod'
import { NextResponse } from 'next/server'
import { readAuthenticatedUser } from '@/lib/auth/server-session'
import { AuthRequestInterruptedError, AuthUnavailableError } from '@/lib/auth/session-check'
import { readJsonBody, type JsonBodyResult } from '@/lib/request-body'
import { getAIServiceFailure } from '@/ai/service-error'
import { requestOrigin } from '@/lib/auth/request-origin'

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public headers?: Record<string, string>) {
    super(message)
    this.name = 'ApiError'
  }
}

export function apiJson(body: unknown, requestId: string, status = 200, headers?: Record<string, string>) {
  return NextResponse.json(body, { status, headers: { ...headers, 'Cache-Control': 'private, no-store', 'X-Request-Id': requestId } })
}

export function apiFailure(reason: unknown, requestId: string) {
  const error = authenticationApiError(reason)
  const expected = error instanceof ApiError
  const service = expected ? undefined : getAIServiceFailure(error)
  if (!expected) console.error('API request failed', { requestId, errorName: error instanceof Error ? error.name : 'UnknownError',
    ...(service ? { code: service.code, upstreamStatus: service.upstreamStatus } : {}) })
  if (expected && error.code === 'AUTH_UNAVAILABLE') console.warn('Authentication check unavailable', { requestId, code: error.code })
  return apiJson({ error: {
    code: expected ? error.code : service?.code ?? 'UPSTREAM_ERROR',
    message: expected ? error.message : service?.message ?? 'The service could not complete this request. Please retry.',
    requestId,
  } }, requestId, expected ? error.status : service?.status ?? 502, expected ? error.headers : undefined)
}

export function assertSameOrigin(request: Request) {
  if (request.headers.get('origin') !== requestOrigin(request)) {
    throw new ApiError(403, 'INVALID_ORIGIN', 'This request must come from the CodeTutor application.')
  }
}

export function requestBodyFailure(reason: Extract<JsonBodyResult, { ok: false }>['reason'], invalidCode = 'INVALID_REQUEST', invalidMessage = 'Send a valid, bounded JSON request.') {
  if (reason === 'timeout' || reason === 'aborted') return new ApiError(408, 'REQUEST_INTERRUPTED', 'The request body timed out or was cancelled. No changes were started; retry the request.')
  if (reason === 'too-large') return new ApiError(413, 'REQUEST_TOO_LARGE', 'The request exceeds the size limit. Send a smaller batch.')
  if (reason === 'unsupported-content-type') return new ApiError(415, 'UNSUPPORTED_CONTENT_TYPE', 'Send the request as application/json.')
  return new ApiError(400, invalidCode, invalidMessage)
}

export async function parseBody<T extends z.ZodTypeAny>(request: Request, schema: T, maxBytes = 32 * 1024): Promise<z.infer<T>> {
  const body = await readJsonBody(request, maxBytes)
  if (!body.ok) {
    throw requestBodyFailure(body.reason)
  }
  const result = schema.safeParse(body.data)
  if (!result.success) throw new ApiError(400, 'INVALID_REQUEST', 'The request contains invalid fields.')
  return result.data
}

export async function requireUser(request?: Request) {
  let context: Awaited<ReturnType<typeof readAuthenticatedUser>>
  try { context = await readAuthenticatedUser(request?.signal) }
  catch (error) { throw authenticationApiError(error) }
  const { supabase, user } = context
  if (!user) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to continue.')
  const expectedAccount = request?.headers.get('X-CodeTutor-Account')
  if (expectedAccount && expectedAccount !== user.id) throw new ApiError(409, 'ACCOUNT_CHANGED', 'The signed-in account changed. Reload before continuing.')
  return { supabase, user }
}

function authenticationApiError(error: unknown) {
  if (error instanceof AuthUnavailableError) return new ApiError(503, 'AUTH_UNAVAILABLE', error.message, { 'Retry-After': '5' })
  if (error instanceof AuthRequestInterruptedError) return new ApiError(408, 'AUTH_INTERRUPTED', error.message)
  return error
}

export type AuthContext = Awaited<ReturnType<typeof requireUser>>

export async function requireOwnedProject(projectId: string, context: AuthContext) {
  if (!z.string().uuid().safeParse(projectId).success) throw new ApiError(400, 'INVALID_PROJECT_ID', 'Choose a valid project.')
  const { data, error } = await context.supabase.from('projects').select('*').eq('id', projectId).eq('user_id', context.user.id).maybeSingle()
  if (error) throw error
  if (!data) throw new ApiError(404, 'PROJECT_NOT_FOUND', 'Project not found.')
  return data
}

/** Ownership only: saved source remains readable after the temporary VM expires.
 * Execution and mutations must use requireOwnedSandbox instead.
 */
export async function requireOwnedSandboxRecord(sandboxId: string, context: AuthContext, signal?: AbortSignal) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sandboxId)) throw new ApiError(400, 'INVALID_SANDBOX_ID', 'Choose a valid sandbox.')
  let query = context.supabase.from('sandbox_sessions').select('*').eq('sandbox_id', sandboxId).eq('user_id', context.user.id)
  if (signal) query = query.abortSignal(signal)
  const { data, error } = await query.maybeSingle()
  if (error) throw error
  if (!data) throw new ApiError(404, 'SANDBOX_NOT_FOUND', 'Sandbox not found.')
  return data
}

export async function requireOwnedSandbox(sandboxId: string, context: AuthContext, signal?: AbortSignal) {
  const data = await requireOwnedSandboxRecord(sandboxId, context, signal)
  if (data.status === 'stopping' && Date.parse(data.expires_at) > Date.now()) throw new ApiError(409, 'SANDBOX_STOPPING', 'This sandbox is saving its final source before shutdown. Wait for completion or retry shutdown if saving failed.')
  if (data.status !== 'running' || Date.parse(data.expires_at) <= Date.now()) throw new ApiError(410, 'SANDBOX_EXPIRED', 'This sandbox expired. Restore your project to continue.')
  return data
}
