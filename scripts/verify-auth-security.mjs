// Explicit hosted check. Creates one disposable, confirmed account and removes
// it in finally. Never sends email, opens a magic link, or touches customer data.
import { randomBytes, randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const publicKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
const secretKey = process.env.SUPABASE_SECRET_KEY
if (!url || !publicKey || !secretKey) throw new Error('Load the configured Supabase environment first.')
const authOptions = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
const boundedFetch = (input, init) => fetch(input, {
  ...init, signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(init?.signal ? [init.signal] : [])]),
})
const admin = createClient(url, secretKey, { auth: authOptions, global: { fetch: boundedFetch } })
const client = createClient(url, publicKey, { auth: authOptions, global: { fetch: boundedFetch } })
const email = `codetutor-security-${randomUUID()}@example.invalid`
const password = randomBytes(24).toString('hex')
const origins = [
  'https://codetutor-studio.vercel.app',
  'http://localhost:3010',
  'http://127.0.0.1:3010',
  'http://localhost:3112',
  'http://127.0.0.1:3112',
]
let userId
let stage = 'fixture-creation'
const checks = []

async function linkDestination(redirectTo) {
  const result = await admin.auth.admin.generateLink({ type: 'magiclink', email, options: { redirectTo } })
  if (result.error || !result.data.properties?.action_link) throw new Error('Link generation failed')
  // Never print the action link, OTP, hash, session or password.
  return new URL(result.data.properties.action_link).searchParams.get('redirect_to')
}

try {
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (created.error || !created.data.user?.id) throw new Error('Fixture creation failed')
  userId = created.data.user.id
  stage = 'password-sign-in'
  const signedIn = await client.auth.signInWithPassword({ email, password })
  if (signedIn.error || signedIn.data.user?.id !== userId) throw new Error('Fixture sign-in failed')
  stage = 'leaked-password-rejection'
  const weak = await client.auth.updateUser({ password: 'password' })
  checks.push({ check: stage, passed: weak.error?.code === 'weak_password' && weak.error.reasons?.includes('pwned') === true })

  stage = 'callback-allowlist'
  for (const origin of origins) {
    for (const withNext of [false, true]) {
      const callback = new URL('/auth/callback', origin)
      if (withNext) callback.searchParams.set('next', '/playground?modelId=openai/gpt-5-nano')
      const returned = await linkDestination(callback.toString())
      checks.push({ check: stage, origin, withNext, passed: returned === callback.toString(),
        ...(returned !== callback.toString() ? { returnedOrigin: returned ? new URL(returned).origin : null } : {}),
      })
    }
  }
  for (const [check, denied] of [
    ['external-callback-denied', 'https://unrelated.example.invalid/auth/callback'],
    ['lookalike-origin-denied', 'https://codetutor-studio.vercel.app.example.invalid/auth/callback?next=%2Fplayground'],
    ['other-production-path-denied', 'https://codetutor-studio.vercel.app/not-auth'],
    ['callback-suffix-denied', 'https://codetutor-studio.vercel.app/auth/callback-other?next=%2Fplayground'],
  ]) {
    checks.push({ check, passed: await linkDestination(denied) !== denied })
  }
  checks.forEach(check => console.log(JSON.stringify(check)))
  if (checks.some(check => !check.passed)) process.exitCode = 1
} catch {
  // Stage names are fixed; provider errors can contain private request details.
  console.error(JSON.stringify({ check: stage, passed: false, message: 'Hosted check could not be confirmed.' }))
  process.exitCode = 1
} finally {
  if (userId) {
    let signedOut = false
    try { signedOut = !(await client.auth.signOut({ scope: 'local' })).error } catch { /* Still delete our own fixture. */ }
    let removed = false
    try { removed = !(await admin.auth.admin.deleteUser(userId)).error } catch { /* Report incomplete cleanup below. */ }
    console.log(JSON.stringify({ check: 'fixture-cleanup', userId, signedOut, removed }))
    if (!signedOut || !removed) process.exitCode = 1
  }
}
