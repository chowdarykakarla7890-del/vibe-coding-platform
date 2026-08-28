import { expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { setTimeout as pause } from 'node:timers/promises'
import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import { Sandbox } from '@vercel/sandbox'
import { getSandboxCredentials, isSandboxUnavailableError } from '@/ai/sandbox'
import { previewReceiptSchema } from '@/lib/sandbox/preview'

// Explicitly authorized opt-in: local rebuilt app, two disposable users,
// one VM and fixed HTTP fixtures. No AI, OAuth, email or customer data.
it.skipIf(process.env.RUN_LIVE_PREVIEW !== '1')('opens only live owned preview origins through authenticated HTTP routes', async () => {
  const base = process.env.TEST_APP_URL ?? 'http://127.0.0.1:3112'
  if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('Use a local test application.')
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, secret = process.env.SUPABASE_SECRET_KEY!
  if (!url || !key || !secret) throw new Error('Load the configured Supabase environment.')
  const boundedFetch: typeof fetch = (input, init) => fetch(input, { ...init, signal: AbortSignal.any([AbortSignal.timeout(45_000), ...(init?.signal ? [init.signal] : [])]) })
  const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: boundedFetch } })
  const users: string[] = [], clients: ReturnType<typeof createServerClient>[] = []
  let sandboxId: string | undefined
  type Account = { id: string; cookies: Map<string, string> }
  async function account(): Promise<Account> {
    const email = `preview-check-${randomUUID()}@example.invalid`, password = randomBytes(24).toString('hex')
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true })
    if (created.error || !created.data.user) throw new Error('Disposable account creation failed.')
    users.push(created.data.user.id)
    const cookies = new Map<string, string>()
    const client = createServerClient(url, key, { global: { fetch: boundedFetch }, cookies: {
      getAll: () => [...cookies].map(([name, value]) => ({ name, value })),
      setAll: values => values.forEach(({ name, value }) => cookies.set(name, value)),
    } })
    clients.push(client)
    if ((await client.auth.signInWithPassword({ email, password })).error) throw new Error('Disposable sign-in failed.')
    return { id: created.data.user.id, cookies }
  }
  async function request(path: string, account?: Account, method = 'GET', body?: unknown, origin = base) {
    return boundedFetch(new URL(path, base), { method, redirect: 'manual', headers: {
      ...(account ? { cookie: [...account.cookies].map(([name, value]) => `${name}=${value}`).join('; '), 'X-CodeTutor-Account': account.id } : {}),
      ...(method !== 'GET' ? { origin, 'content-type': 'application/json' } : {}),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  }
  async function body(response: Response, status = 200) {
    const value = await response.json()
    if (response.status !== status) throw new Error(`Preview API returned ${response.status} ${value.error?.code ?? ''}; expected ${status}.`)
    expect(response.headers.get('x-request-id')).toBeTruthy()
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    return value
  }
  try {
    const a = await account(), b = await account()
    const { project } = await body(await request('/api/projects', a, 'POST', { title: 'Disposable preview A' }), 201)
    const { project: second } = await body(await request('/api/projects', a, 'POST', { title: 'Disposable preview B' }), 201)
    const created = await body(await request('/api/sandboxes', a, 'POST', { projectId: project.id, ports: [3000, 8000], timeout: 600_000 }), 201)
    sandboxId = created.sandboxId
    const report = { sandboxId, lines: [{ command: 'python3', args: ['-m', 'http.server', '3000'], stream: 'stderr', timestamp: 1,
      data: '100.64.0.1 - - [27/Aug/2026 23:42:18] "GET /error HTTP/1.1" 200 -' }], previous: [] }
    await body(await request('/api/errors', undefined, 'POST', report), 401)
    await body(await request('/api/errors', b, 'POST', report), 404)
    await body(await request('/api/errors', a, 'POST', report, 'https://evil.example'), 403)
    await body(await request('/api/errors', a, 'POST', { ...report, sandboxId: '../escape' }), 400)
    expect(await body(await request('/api/errors', a, 'POST', report))).toEqual({ shouldBeFixed: false, summary: '', paths: [] })
    console.log('PASS: routine error reports are ignored through authenticated HTTP; cross-user and invalid-origin reports are denied without AI usage.')
    const endpoint = `/api/sandboxes/${sandboxId}/preview`
    const query = `${endpoint}?projectId=${project.id}`
    await body(await request(query), 401)
    await body(await request(query, b), 404)
    await body(await request(`${endpoint}?projectId=${second.id}`, a), 404)
    await body(await request(`${query}&port=9000`, a), 400)
    await body(await request(endpoint, a, 'POST', { projectId: project.id, url: 'https://evil.vercel.run' }), 400)
    await body(await request(endpoint, a, 'POST', { projectId: project.id, port: 3000 }, 'https://evil.example'), 403)
    const first = previewReceiptSchema.parse(await body(await request(query, a)))
    expect(first).toMatchObject({ port: 3000, ports: [3000, 8000], sandboxId, projectId: project.id })
    const chosen = previewReceiptSchema.parse(await body(await request(endpoint, a, 'POST', { projectId: project.id, port: 8000 })))
    expect(chosen.port).toBe(8000)
    expect(chosen.url).not.toBe(first.url)
    expect(previewReceiptSchema.parse(await body(await request(query, a)))).toEqual(chosen)
    console.log('PASS: real authentication, cross-user/project denial, port validation and persistent preview selection.')

    const marker = `Preview fixture ${randomUUID()}`
    const script = `const http=require('node:http');for(const port of [3000,8000])http.createServer((_,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Owned preview</title><h1>${marker}</h1><p>'+port+'</p>')}).listen(port,'0.0.0.0')`
    await body(await request(`/api/sandboxes/${sandboxId}/terminal`, a, 'POST', { command: `node -e ${JSON.stringify(script)}`, background: true }))
    for (const preview of [first, chosen]) {
      let html = ''
      for (let attempt = 0; attempt < 10; attempt++) {
        const response = await boundedFetch(preview.url)
        html = await response.text()
        if (response.ok && html.includes(marker)) break
        await pause(500)
      }
      expect(html).toContain(marker)
      expect(html).toContain(`<p>${preview.port}</p>`)
    }
    const page = await request('/playground', a)
    expect(page.headers.get('content-security-policy')).toContain('frame-src https://*.vercel.run')
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(page.headers.get('x-content-type-options')).toBe('nosniff')
    console.log('PASS: manual terminal command serves both verified HTTPS previews without an AI call; app security headers are present.')
    const vm = (await Sandbox.get({ name: sandboxId!, resume: false, ...getSandboxCredentials(), signal: AbortSignal.timeout(10_000) })).currentSession()
    await vm.stop({ signal: AbortSignal.timeout(15_000) })
    await body(await request(query, a), 410)
    await body(await request(endpoint, a, 'POST', { projectId: project.id, port: 3000 }), 410)
    await body(await request('/api/errors', a, 'POST', report), 410)
    console.log('PASS: stopped VM rejects preview reads and connections without automatic resumption.')
  } finally {
    const failures: string[] = []
    const names = new Set(sandboxId ? [sandboxId] : [])
    if (users.length) {
      const rows = await admin.from('sandbox_sessions').select('id,sandbox_id').in('user_id', users)
      if (rows.error) failures.push('sandbox lookup')
      else rows.data.forEach(row => names.add(row.sandbox_id ?? `codetutor-${row.id}`))
    }
    for (const name of names) {
      try {
        const sandbox = await Sandbox.get({ name, resume: false, ...getSandboxCredentials(), signal: AbortSignal.timeout(10_000) })
        await sandbox.stop({ signal: AbortSignal.timeout(15_000) })
      } catch (error) { if (!isSandboxUnavailableError(error)) failures.push('sandbox shutdown') }
    }
    for (const client of clients) if ((await client.auth.signOut({ scope: 'global' })).error) failures.push('session revocation')
    for (const id of users) if ((await admin.auth.admin.deleteUser(id)).error) failures.push('account deletion')
    if (failures.length) throw new Error(`Disposable preview cleanup failed: ${failures.join(', ')}`)
    console.log('Cleaned up disposable preview users, sessions, projects and sandbox.')
  }
}, 240_000)
