'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getPublicSupabaseConfig } from '@/lib/supabase/config'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { safeNextPath } from '@/lib/auth/redirect'
import { fetchSignInMethods, navigateToOAuth, oauthRedirectUrl, type OAuthMethod, type SignInMethods } from '@/lib/auth/sign-in-methods'
import { readWithDeadline } from '@/lib/abortable-read'
import { awaitMutationReceipt, MutationReceiptTimeoutError } from '@/lib/mutation-receipt'

type Availability = { state: 'loading' } | { state: 'error' } | { state: 'ready'; methods: SignInMethods }
type SignInMethod = 'email' | OAuthMethod
const providerNames = { github: 'GitHub', google: 'Google' }

export function SignInForm({ next, callbackFailed }: { next?: string; callbackFailed: boolean }) {
  const [availability, setAvailability] = useState<Availability>({ state: 'loading' })
  const [version, setVersion] = useState(0)
  const [email, setEmail] = useState('')
  const [pending, setPending] = useState<SignInMethod>()
  const [sent, setSent] = useState(false)
  const [resendReady, setResendReady] = useState(false)
  const [error, setError] = useState(callbackFailed ? 'Sign-in could not be verified. Try your provider again or request a new email link in this browser.' : '')
  const attempt = useRef<AbortController | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    void readWithDeadline(signal => fetchSignInMethods(getPublicSupabaseConfig(), signal), controller.signal, 10_000, 'Sign-in settings timed out.')
      .then(methods => { if (!controller.signal.aborted) setAvailability({ state: 'ready', methods }) })
      .catch(() => { if (!controller.signal.aborted) setAvailability({ state: 'error' }) })
    return () => controller.abort()
  }, [version])

  useEffect(() => () => { attempt.current?.abort() }, [])
  useEffect(() => {
    if (!sent) return
    const timer = setTimeout(() => setResendReady(true), 60_000)
    return () => clearTimeout(timer)
  }, [sent])

  function retryMethods() {
    setAvailability({ state: 'loading' })
    setVersion(value => value + 1)
  }

  async function signIn(method: SignInMethod) {
    if (attempt.current || availability.state !== 'ready' || !availability.methods[method] || (method === 'email' && sent && !resendReady)) return
    const controller = new AbortController()
    attempt.current = controller
    setPending(method)
    setError('')
    if (method === 'email') { setSent(false); setResendReady(false) }
    try {
      const callback = new URL('/auth/callback', window.location.origin)
      callback.searchParams.set('next', safeNextPath(next))
      if (method === 'email') {
        // The SDK has no per-call abort option here. Bound our receipt wait,
        // but do not claim to cancel delivery or retry the write automatically.
        const { error: authError } = await awaitMutationReceipt(
          () => createClient().auth.signInWithOtp({ email: email.trim(), options: { emailRedirectTo: callback.toString() } }),
          controller.signal, 20_000, 'Email delivery could not be confirmed. A link may still arrive; check your inbox before trying again. Use the newest link in this browser.',
        )
        if (controller.signal.aborted) return
        if (authError) setError(authError.status === 429 ? 'Too many requests. Wait a minute before trying again.' : 'A sign-in link could not be sent. Please try again shortly.')
        else { setSent(true); setResendReady(false) }
      } else {
        const result = await awaitMutationReceipt(
          () => createClient().auth.signInWithOAuth({ provider: method, options: { redirectTo: callback.toString(), skipBrowserRedirect: true } }),
          controller.signal, 20_000, `${providerNames[method]} sign-in could not be confirmed. Please retry.`,
        )
        if (controller.signal.aborted) return
        if (result.error) throw result.error
        const url = oauthRedirectUrl(result.data.url, method, callback.toString(), getPublicSupabaseConfig())
        navigateToOAuth(url)
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof MutationReceiptTimeoutError ? cause.message : method === 'email'
        ? 'Could not reach the sign-in service. Check your connection and retry.'
        : `${providerNames[method]} sign-in could not be started. Please retry.`)
    } finally {
      if (attempt.current === controller) {
        attempt.current = null
        if (!controller.signal.aborted) setPending(undefined)
      }
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!event.currentTarget.checkValidity()) return
    void signIn('email')
  }

  const methods = availability.state === 'ready' ? availability.methods : undefined
  const available = methods && (methods.email || methods.github || methods.google)
  return <div className="space-y-4">
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    {availability.state === 'loading' ? <p role="status" className="text-sm text-muted-foreground">Loading sign-in options…</p> : !available ? <div className="space-y-3">
      <p role="alert" className="text-sm text-muted-foreground">{availability.state === 'error' ? 'Sign-in options could not be loaded. Check your connection and retry.' : 'Sign-in is temporarily unavailable. Please try again later.'}</p>
      <Button variant="outline" type="button" onClick={retryMethods}>Retry sign-in options</Button>
    </div> : <>
      {methods.signupDisabled ? <p className="text-sm text-muted-foreground">New registrations are closed. Existing accounts can still sign in.</p> : null}
      {methods.email ? <form onSubmit={submit} className="space-y-4" aria-busy={pending === 'email'}>
        <div className="space-y-2"><label htmlFor="email" className="text-sm">Email address</label><Input id="email" name="email" type="email" autoComplete="email" maxLength={254} required value={email} onChange={event => { setEmail(event.target.value); setSent(false); setResendReady(false) }} disabled={!!pending} placeholder="you@example.com" /></div>
        {sent ? <p role="status" className="text-sm text-muted-foreground">Check your inbox for a sign-in link. Open the newest link in this browser to finish signing in.</p> : null}
        <Button type="submit" className="w-full" disabled={!!pending || sent}>{pending === 'email' ? 'Sending link…' : sent ? 'Link sent' : 'Continue with email'}</Button>
        {sent ? <Button type="button" variant="ghost" className="w-full" disabled={!!pending || !resendReady} onClick={() => void signIn('email')}>{resendReady ? 'Request another link' : 'You can request another link in a minute'}</Button> : null}
      </form> : null}
      {(['github', 'google'] as const).filter(provider => methods[provider]).map(provider => <Button key={provider} type="button" className="w-full" variant="outline" disabled={!!pending} onClick={() => void signIn(provider)}>{pending === provider ? `Opening ${providerNames[provider]}…` : `Continue with ${providerNames[provider]}`}</Button>)}
      {pending && pending !== 'email' ? <p role="status" className="text-sm text-muted-foreground">Opening {providerNames[pending]} sign-in…</p> : null}
    </>}
    <p className="text-xs leading-5 text-muted-foreground">No password needed. Your existing device-local projects are not deleted or automatically uploaded when you sign in.</p>
  </div>
}
