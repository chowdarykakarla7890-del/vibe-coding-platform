import { SignInForm } from '@/components/auth/sign-in-form'

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const params = await searchParams
  return <main className="grid min-h-dvh place-items-center bg-background p-6"><section className="w-full max-w-sm rounded-xl border border-border bg-card p-6"><p className="mb-6 text-sm font-medium">CodeTutor Studio</p><h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1><p className="mb-6 mt-2 text-sm leading-6 text-muted-foreground">Sign in to keep your learning projects connected to your account.</p><SignInForm next={params.next} callbackFailed={params.error === 'callback'} /></section></main>
}
