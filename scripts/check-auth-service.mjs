import { fetchSignInMethods, signInReadinessIssues } from '../lib/auth/sign-in-methods.ts'
import { readWithDeadline } from '../lib/abortable-read.ts'

// Read-only: no email, OAuth flow, user, secret-key request or config mutation.
try {
  const methods = await readWithDeadline(signal => fetchSignInMethods({
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
    publishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '',
  }, signal), new AbortController().signal, 10_000, 'Auth settings timed out.')
  console.log(JSON.stringify({ check: 'public-auth-settings', ...methods }))
  const issues = signInReadinessIssues(methods)
  issues.forEach(code => console.error(`${code}: complete the corresponding Supabase Auth setup before release.`))
  if (issues.length) process.exitCode = 1
  else console.log('Required provider flags are enabled. This is not an end-to-end authentication pass.')
  console.log('Still verify email delivery, OAuth credentials/consent, redirect allowlists, PKCE callback and session isolation in each deployment environment.')
} catch {
  console.error('AUTH_SETTINGS_UNAVAILABLE: verify the public Supabase configuration and connectivity, then retry. No raw service response or credentials were logged.')
  process.exitCode = 1
}
