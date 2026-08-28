import { APIError, StreamError } from '@vercel/sandbox'

/**
 * The Sandbox SDK can authenticate with either a Vercel OIDC JWT or an API
 * token paired with a team and project. Local development uses the latter so
 * it does not depend on a deployment-time OIDC header.
 */
export function getSandboxCredentials() {
  const token = process.env.VERCEL_AUTH_TOKEN
  const teamId = process.env.VERCEL_TEAM_ID
  const projectId = process.env.VERCEL_PROJECT_ID

  return token && teamId && projectId ? { token, teamId, projectId } : {}
}

export function getSandboxErrorCode(error: unknown) {
  if (error instanceof StreamError) return error.code
  if (!(error instanceof APIError)) return undefined
  const payload = error.json as { error?: { code?: unknown } } | undefined
  return typeof payload?.error?.code === 'string'
    ? payload.error.code
    : undefined
}

export function isSandboxUnavailableError(error: unknown) {
  const code = getSandboxErrorCode(error)
  return code === 'not_found' || code === 'sandbox_stopped' || code === 'session_stopped'
}
