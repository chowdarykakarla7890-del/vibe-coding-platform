'use client'

import { useEffect, useRef, useState } from 'react'
import { useWorkspaceAccount } from './user-workspace'
import { useSandboxStore } from '@/app/state'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { openSignInAfterSignOut, SIGN_OUT_UNCONFIRMED, SignOutAccountChangedError, signOutWorkspace } from '@/lib/auth/sign-out'

export function SignOut() {
  const { userId } = useWorkspaceAccount()
  return <SignOutControl key={userId} userId={userId} />
}

function SignOutControl({ userId }: { userId: string }) {
  const dirtyPath = useSandboxStore(state => state.dirtyFilePath)
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<'idle' | 'pending' | 'error' | 'complete' | 'account-changed'>('idle')
  const attempt = useRef<AbortController | null>(null)
  useEffect(() => () => { attempt.current?.abort() }, [])
  const pending = status === 'pending'

  async function submit() {
    // Read synchronously too: a draft can change before React commits disabled.
    if (attempt.current || useSandboxStore.getState().dirtyFilePath || status === 'complete' || status === 'account-changed') return
    const controller = new AbortController()
    attempt.current = controller
    setStatus('pending')
    try {
      await signOutWorkspace(userId, controller.signal)
      if (controller.signal.aborted) return
      setStatus('complete')
    } catch (error) {
      if (!controller.signal.aborted) setStatus(error instanceof SignOutAccountChangedError ? 'account-changed' : 'error')
      return
    } finally {
      if (attempt.current === controller) attempt.current = null
    }
    // Keep an explicit continuation if navigation is prevented by the browser.
    openSignInAfterSignOut()
  }

  return <Dialog open={open} onOpenChange={next => { if (!attempt.current && status !== 'complete') setOpen(next) }}>
    <DialogTrigger asChild><button type="button" className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Sign out</button></DialogTrigger>
    <DialogContent showCloseButton={!pending && status !== 'complete'} aria-busy={pending}>
      <DialogHeader>
        <DialogTitle>{status === 'complete' ? 'Signed out' : 'Sign out of CodeTutor?'}</DialogTitle>
        <DialogDescription>This signs out the current browser session only. Saved projects stay in your account. Save any unsaved work before continuing.</DialogDescription>
      </DialogHeader>
      {dirtyPath ? <p role="alert" className="text-sm">You have unsaved edits in {dirtyPath}. Return to the workspace and save or copy them before signing out.</p> : null}
      {status === 'error' ? <p role="alert" className="text-sm text-destructive">{SIGN_OUT_UNCONFIRMED}</p> : null}
      {status === 'account-changed' ? <p role="alert" className="text-sm text-destructive">The signed-in account changed. Save or copy unsaved changes, then reload the workspace before trying again.</p> : null}
      {pending || status === 'complete' ? <p role="status" aria-live="polite" className="text-sm text-muted-foreground">{pending ? 'Confirming sign-out…' : 'Sign-out confirmed. Opening sign-in…'}</p> : null}
      <DialogFooter>
        {status === 'complete' ? <Button onClick={openSignInAfterSignOut}>Continue to sign in</Button> : <>
          <Button variant="outline" disabled={pending} onClick={() => setOpen(false)}>Return to workspace</Button>
          <Button disabled={pending || !!dirtyPath || status === 'account-changed'} onClick={() => void submit()}>{pending ? 'Signing out…' : status === 'error' ? 'Retry sign-out' : 'Confirm sign-out'}</Button>
        </>}
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
