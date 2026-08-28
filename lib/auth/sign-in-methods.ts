import { z } from 'zod'

const settingsSchema = z.object({
  external: z.object({ email: z.boolean(), github: z.boolean(), google: z.boolean() }),
  disable_signup: z.boolean(),
})

export type SignInMethods = { email: boolean; github: boolean; google: boolean; signupDisabled: boolean }
export type OAuthMethod = 'github' | 'google'
export type PublicAuthConfig = { supabaseUrl: string; publishableKey: string }

export function signInReadinessIssues(methods: SignInMethods): string[] {
  const issues = (['email', 'github', 'google'] as const).filter(method => !methods[method]).map(method => `${method.toUpperCase()}_DISABLED`)
  if (methods.signupDisabled) issues.push('REGISTRATION_DISABLED')
  return issues
}

function authOrigin(config: PublicAuthConfig) {
  const url = new URL(config.supabaseUrl)
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !config.publishableKey || config.publishableKey.startsWith('sb_secret_')) {
    throw new Error('The sign-in service is not configured correctly.')
  }
  return url.origin
}

/** Public provider flags only. This is not proof of email/OAuth delivery. */
export async function fetchSignInMethods(config: PublicAuthConfig, signal: AbortSignal): Promise<SignInMethods> {
  signal.throwIfAborted()
  const response = await fetch(`${authOrigin(config)}/auth/v1/settings`, {
    headers: { apikey: config.publishableKey }, signal, cache: 'no-store', credentials: 'omit', redirect: 'error',
  })
  signal.throwIfAborted()
  if (!response.ok) throw new Error('Sign-in methods could not be loaded. Please retry.')
  const body: unknown = await response.json()
  signal.throwIfAborted()
  const parsed = settingsSchema.safeParse(body)
  if (!parsed.success) throw new Error('The sign-in service returned invalid settings. Please retry.')
  return { ...parsed.data.external, signupDisabled: parsed.data.disable_signup }
}

/** Only navigate to the configured Auth endpoint for this exact flow. */
export function oauthRedirectUrl(value: string | null | undefined, provider: OAuthMethod, callback: string, config: PublicAuthConfig): string {
  const url = new URL(value ?? '')
  if (url.origin !== authOrigin(config) || url.pathname !== '/auth/v1/authorize' || url.username || url.password || url.hash ||
    url.searchParams.getAll('provider').length !== 1 || url.searchParams.get('provider') !== provider ||
    url.searchParams.getAll('redirect_to').length !== 1 || url.searchParams.get('redirect_to') !== callback) {
    throw new Error('The sign-in destination could not be verified.')
  }
  return url.toString()
}

export function navigateToOAuth(url: string) {
  window.location.assign(url)
}
