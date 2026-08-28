'use client'

import { useEffect } from 'react'
import { errorDiagnostics } from '@/lib/client/error-diagnostics'

export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error('Fatal application error', errorDiagnostics(error))
  }, [error])

  return <html lang="en"><body><main style={{ display: 'grid', minHeight: '100vh', placeItems: 'center', background: '#0f1012', color: '#f4f4f5', fontFamily: 'system-ui' }}><div style={{ maxWidth: 440, padding: 32, textAlign: 'center' }}><h1>CodeTutor could not load</h1><p style={{ color: '#a1a1aa', lineHeight: 1.6 }}>This error has not cleared your saved work. Retry the application to reconnect the interface. Do not clear site data to fix this.</p><button onClick={retry} style={{ marginTop: 16, border: 0, borderRadius: 6, padding: '10px 16px' }}>Try again</button><p><button onClick={() => window.location.reload()} style={{ border: 0, background: 'transparent', color: '#a1a1aa', textDecoration: 'underline' }}>Reload application</button></p></div></main></body></html>
}
