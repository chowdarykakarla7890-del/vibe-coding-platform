export type DeploymentTarget = 'preview' | 'production'
type Environment = Record<string, string | undefined>
export interface DeploymentBindings {
  projectId: string
  sandboxProjectId: string
  teamId: string
  productionDatabaseRef: string
  previewDatabaseRef: string | null
}

// Non-secret, independently reviewed bindings. Never derive the expected
// Preview database from the same environment variable being validated.
export const deploymentBindings: DeploymentBindings = {
  projectId: 'prj_Rwq4j0K6nwuPhwjMgGs4lmILPlm1',
  sandboxProjectId: 'prj_JP9PfTEAzWddZhN84kW2Izn7Hdeu',
  teamId: 'team_chkKryJm6LQHYeddRXwFI5Bx',
  productionDatabaseRef: 'lyxbhjebtkvaihmjyjtk',
  previewDatabaseRef: null, // Provision and verify an isolated branch first.
}

export interface EnvironmentIssue { code: string; message: string }

/** Offline configuration checks only: this does not prove key validity, RLS,
 * migrations, OAuth delivery, credential rotation, or production readiness. */
export function checkDeploymentEnvironment(
  env: Environment,
  target: string | undefined,
  nodeVersion: string,
  bindings: DeploymentBindings = deploymentBindings,
): EnvironmentIssue[] {
  const issues: EnvironmentIssue[] = []
  const fail = (code: string, message: string) => issues.push({ code, message })
  if (!/^24\./.test(nodeVersion)) fail('NODE_VERSION', 'Use Node 24 for development and deployment.')
  if (target !== 'preview' && target !== 'production') {
    fail('DEPLOYMENT_TARGET', 'Select an explicit preview or production deployment target.')
  }
  if (env.VERCEL_ENV && env.VERCEL_ENV !== target) {
    fail('TARGET_MISMATCH', 'The requested target does not match VERCEL_ENV.')
  }
  if (env.VERCEL_TARGET_ENV && env.VERCEL_TARGET_ENV !== target) {
    fail('TARGET_MISMATCH', 'Custom deployment environments need separately reviewed service bindings.')
  }
  // Existing API-token credentials deliberately use the CLI's Sandbox-only
  // project. OIDC deployments can use the application project instead.
  if (![bindings.projectId, bindings.sandboxProjectId].includes(env.VERCEL_PROJECT_ID ?? '')) fail('PROJECT_BINDING', 'VERCEL_PROJECT_ID must match a reviewed CodeTutor application or Sandbox project.')
  if (env.VERCEL_TEAM_ID !== bindings.teamId) fail('TEAM_BINDING', 'VERCEL_TEAM_ID must match the reviewed CodeTutor team.')

  let databaseRef: string | undefined
  try {
    const raw = env.NEXT_PUBLIC_SUPABASE_URL
    const url = new URL(raw ?? '')
    const match = /^([a-z0-9]{20})\.supabase\.co$/.exec(url.hostname)
    if (!raw || raw.trim() !== raw || url.protocol !== 'https:' || !match || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) throw new Error()
    databaseRef = match[1]
  } catch {
    fail('DATABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL must be a hosted Supabase HTTPS origin without credentials or a path.')
  }
  const expectedRef = target === 'production' ? bindings.productionDatabaseRef : bindings.previewDatabaseRef
  if (target === 'preview' && !bindings.previewDatabaseRef) {
    fail('PREVIEW_DATABASE_UNCONFIGURED', 'Provision and record an isolated Supabase Preview branch before deploying.')
  }
  if (target === 'preview' && (databaseRef === bindings.productionDatabaseRef || bindings.previewDatabaseRef === bindings.productionDatabaseRef)) {
    fail('PREVIEW_DATABASE_ISOLATION', 'Preview must not use the production database.')
  }
  if (databaseRef && expectedRef && databaseRef !== expectedRef) {
    fail('DATABASE_BINDING', 'The Supabase URL does not match the reviewed deployment target.')
  }

  const publishable = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? ''
  const secret = env.SUPABASE_SECRET_KEY ?? ''
  if (!/^sb_publishable_[A-Za-z0-9_-]{20,}$/.test(publishable)) {
    fail('PUBLISHABLE_KEY', 'Configure a Supabase publishable key in NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, never a secret or service-role key.')
  }
  if (!/^sb_secret_[A-Za-z0-9_-]{20,}$/.test(secret)) {
    fail('SERVER_KEY', 'Configure SUPABASE_SECRET_KEY as a server-only Supabase secret key.')
  }
  const cron = env.CRON_SECRET ?? ''
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(cron)) {
    fail('WORKER_SECRET', 'Configure CRON_SECRET with 32–256 random URL-safe characters, separately for each environment.')
  }
  const serverSecrets = [secret, cron, env.AI_GATEWAY_API_KEY, env.VERCEL_AUTH_TOKEN, env.VERCEL_OIDC_TOKEN].filter((value): value is string => Boolean(value))
  if (cron && [secret, env.AI_GATEWAY_API_KEY, env.VERCEL_AUTH_TOKEN, env.VERCEL_OIDC_TOKEN].includes(cron)) {
    fail('SECRET_REUSE', 'CRON_SECRET must be independent of database and provider credentials.')
  }
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('NEXT_PUBLIC_') || !value) continue
    if (/sb_secret_|\bvcp_|\bvck_/.test(value) || serverSecrets.some((serverSecret) => value.includes(serverSecret))) {
      fail('PUBLIC_SECRET_EXPOSURE', 'A NEXT_PUBLIC_ variable contains a server credential. Remove it before building.')
      break
    }
  }

  const cleanToken = (value: string | undefined) => Boolean(value && value.length >= 24 && !/\s/.test(value))
  const oidc = env.VERCEL_OIDC_TOKEN
  const hasOidc = Boolean(oidc && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(oidc))
  if (!cleanToken(env.AI_GATEWAY_API_KEY) && !hasOidc) {
    fail('GATEWAY_AUTH', 'Configure AI Gateway authentication with a server-only key or Vercel OIDC.')
  }
  if (!cleanToken(env.VERCEL_AUTH_TOKEN) && !hasOidc) {
    fail('SANDBOX_AUTH', 'Configure Sandbox authentication with a server-only token or Vercel OIDC.')
  }
  if (env.VERCEL_AUTH_TOKEN && !cleanToken(env.VERCEL_AUTH_TOKEN)) {
    fail('SANDBOX_TOKEN', 'Remove or replace the invalid VERCEL_AUTH_TOKEN; it overrides OIDC.')
  }
  if (env.AI_GATEWAY_API_KEY && !cleanToken(env.AI_GATEWAY_API_KEY)) {
    fail('GATEWAY_TOKEN', 'Remove or replace the invalid AI_GATEWAY_API_KEY; it overrides OIDC.')
  }
  return issues
}

export function assertDeploymentEnvironment(env: Environment, nodeVersion: string) {
  if (env.VERCEL !== '1') return
  // `vercel dev` is a local server, not a release. A production build with a
  // development target must still fail rather than bypassing the guard.
  if (env.VERCEL_ENV === 'development' && env.NODE_ENV === 'development') return
  const issues = checkDeploymentEnvironment(env, env.VERCEL_ENV, nodeVersion)
  if (issues.length) {
    // Messages are fixed strings: never include environment values or raw errors.
    throw new Error(`Deployment environment checks failed:\n${issues.map((issue) => `${issue.code}: ${issue.message}`).join('\n')}`)
  }
}
