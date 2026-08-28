export function AuthenticationUnavailable() {
  return (
    <main className="grid min-h-dvh place-items-center bg-background p-6">
      <section className="w-full max-w-md rounded-xl border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">Unable to verify your session</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          The sign-in service is temporarily unavailable. Your saved work has not been cleared. Please try again.
        </p>
        {/* An explicit full GET retries both proxy and server checks while
            preserving the current destination; no automatic redirect loop. */}
        <a href="" className="mt-5 inline-flex rounded-md border border-border px-4 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2">
          Try again
        </a>
      </section>
    </main>
  )
}
