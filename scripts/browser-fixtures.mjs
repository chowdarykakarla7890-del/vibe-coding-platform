// Strictly disposable test infrastructure. Never use a hosted mailbox, a
// developer profile, exported authentication state, or a production database.
export function assertBrowserCiEnvironment(env, filenames) {
  if (env.GITHUB_ACTIONS !== 'true' || env.CI !== 'true') throw new Error('Browser checks require disposable GitHub CI.')
  if (filenames.some(name => name.startsWith('.env') && name !== '.env.example')) throw new Error('Private environment files are forbidden in browser CI.')
  if (env.TEST_APP_URL !== 'http://127.0.0.1:3115' || env.NEXT_PUBLIC_SUPABASE_URL !== 'http://127.0.0.1:54321') throw new Error('Browser CI requires its fixed loopback application and database.')
  if (!env.SUPABASE_SECRET_KEY || !env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) throw new Error('Disposable database keys are missing.')
  if (['VERCEL_AUTH_TOKEN', 'VERCEL_OIDC_TOKEN', 'VERCEL_TOKEN', 'SUPABASE_ACCESS_TOKEN', 'AI_GATEWAY_API_KEY', 'OPENAI_API_KEY'].some(key => env[key])) throw new Error('Paid or hosted credentials are forbidden in browser CI.')
}

export function localEmailVerificationLink(message, email, next) {
  if (!/^codetutor-browser-[a-f0-9-]+-[ab]@example\.invalid$/.test(email)) throw new Error('Unexpected browser fixture recipient.')
  if (!Array.isArray(message?.To) || !message.To.some(to => to.Address === email) || typeof message.HTML !== 'string') throw new Error('Local email does not belong to this fixture.')
  const expected = new URL('/auth/callback', 'http://127.0.0.1:3115')
  expected.searchParams.set('next', next)
  for (const match of message.HTML.matchAll(/href="([^"]+)"/g)) {
    try {
      const link = new URL(match[1].replaceAll('&amp;', '&'))
      if (link.origin === 'http://127.0.0.1:54321' && link.pathname === '/auth/v1/verify'
        && link.searchParams.get('type') === 'magiclink' && link.searchParams.get('token')
        && link.searchParams.get('redirect_to') === expected.href && !link.username && !link.password && !link.hash) return link.href
    } catch { /* Ignore non-URL HTML anchors; never print email or tokens. */ }
  }
  throw new Error('Local email has no matching loopback verification link.')
}
