import Link from 'next/link'

export default function NotFound() {
  return <main className="grid h-full place-items-center p-6"><div className="text-center"><p className="font-mono text-xs text-muted-foreground">404</p><h1 className="mt-2 text-2xl font-semibold">Learning path not found</h1><p className="mt-2 text-sm text-muted-foreground">This activity may only exist in another device’s local catalog.</p><Link className="mt-5 inline-flex rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background" href="/playground">Open Playground</Link></div></main>
}
