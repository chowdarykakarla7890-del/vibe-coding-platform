'use client'

import { Button } from '@/components/ui/button'
import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import { errorDiagnostics } from '@/lib/client/error-diagnostics'

export default function ErrorPage({ error, retry }: { error: unknown; retry: () => void }) {
  const router = useRouter()
  useEffect(() => {
    console.error('Recoverable workspace error', errorDiagnostics(error))
  }, [error])
  return <main className="grid h-full place-items-center p-6"><div className="max-w-md rounded-xl border border-border bg-card p-6 text-center"><h1 className="text-xl font-semibold">The workspace hit a problem</h1><p className="mt-2 text-sm text-muted-foreground">This error has not cleared your saved projects or source snapshots. Retry this view or return to Playground. Do not clear site data to fix this.</p><div className="mt-5 flex justify-center gap-2"><Button onClick={retry}>Try again</Button><Button onClick={() => router.push('/playground')} variant="outline">Playground</Button></div></div></main>
}
