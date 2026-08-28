import { expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import { Sandbox } from '@vercel/sandbox'
import { getSandboxCredentials, isSandboxUnavailableError } from '@/ai/sandbox'
import { processSandboxCleanup } from '@/lib/server/sandbox-cleanup-worker'
import type { Database } from '@/lib/supabase/database.types'

vi.mock('server-only', () => ({}))

// Explicit opt-in. Rebuilt LOCAL app, two disposable accounts, two sequential
// VMs, no AI/email/customer data. Credentials never appear in test output.
it.skipIf(process.env.RUN_LIVE_SANDBOX_CLEANUP !== '1')('cleans deleted and unacknowledged creations through durable owned handles', async () => {
  const base = process.env.TEST_APP_URL ?? 'http://localhost:3112'
  if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('Use the local application only.')
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, secret = process.env.SUPABASE_SECRET_KEY!
  if (!url || !key || !secret) throw new Error('Load the configured Supabase environment.')
  const boundedFetch: typeof fetch = (input, init) => fetch(input, { ...init, signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(init?.signal ? [init.signal] : [])]) })
  const admin = createClient<Database>(url, secret, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: boundedFetch } })
  const users: string[] = [], names = new Set<string>(), clients: ReturnType<typeof createServerClient>[] = []
  type Account = { id: string; cookies: Map<string, string> }
  async function account(): Promise<Account> {
    const email = `sandbox-cleanup-live-${randomUUID()}@example.invalid`, password = randomBytes(24).toString('hex')
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
  async function request(path: string, user: Account | undefined, method = 'GET', value?: unknown, origin = base) {
    return fetch(new URL(path, base), { method, redirect: 'manual', signal: AbortSignal.timeout(90_000), headers: {
      ...(user ? { cookie: [...user.cookies].map(([name, value]) => `${name}=${value}`).join('; '), 'X-CodeTutor-Account': user.id } : {}),
      ...(method !== 'GET' ? { 'content-type': 'application/json', origin } : {}),
    }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) })
  }
  async function body(response: Response, status = 200) {
    const value = await response.json()
    if (response.status !== status) throw new Error(`Cleanup API ${response.status} ${value.error?.code ?? 'unknown'}; expected ${status}`)
    expect(response.headers.get('x-request-id')).toBeTruthy()
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    return value
  }
  async function inspect(id: string) {
    const result = await admin.from('sandbox_cleanup_jobs').select('state,outcome,sandbox_name').eq('id', id).single()
    if (result.error) throw new Error('Cleanup receipt unavailable.')
    return result.data
  }
  async function confirmStopped(name: string) {
    try {
      const box = await Sandbox.get({ name, resume: false, ...getSandboxCredentials(), signal: AbortSignal.timeout(10_000) })
      expect(box.status).toBe('stopped')
    } catch (error) { if (!isSandboxUnavailableError(error)) throw error }
  }
  try {
    const a = await account(), b = await account()
    const { project } = await body(await request('/api/projects', a, 'POST', { title: 'Disposable cleanup HTTP', mode: 'playground', language: 'TypeScript' }), 201)
    const created = await body(await request('/api/sandboxes', a, 'POST', { projectId: project.id, ports: [3000], timeout: 600_000 }), 201)
    names.add(created.sandboxId)
    const session = await admin.from('sandbox_sessions').select('id').eq('project_id', project.id).eq('user_id', a.id).single()
    if (session.error) throw new Error('Sandbox registration missing.')
    expect((await inspect(session.data.id)).state).toBe('attached')
    expect(await processSandboxCleanup(session.data.id)).toBe('idle')
    const path = `/api/projects/${project.id}`
    await body(await request(path, undefined, 'DELETE'), 401)
    await body(await request(path, b, 'DELETE'), 404)
    await body(await request(path, a, 'DELETE', undefined, 'https://wrong.invalid'), 403)
    expect((await inspect(session.data.id)).state).toBe('attached')
    expect(await body(await request(path, a, 'DELETE'))).toMatchObject({ deleted: true, sandboxCleanup: 'scheduled' })
    await body(await request(path, a), 404)
    // This must finish through Next's after callback, not a test-driven worker.
    await vi.waitFor(async () => expect(await inspect(session.data.id)).toMatchObject({ state: 'complete', outcome: 'stopped' }), { timeout: 30_000, interval: 500 })
    await confirmStopped(created.sandboxId)

    const { project: pending } = await body(await request('/api/projects', a, 'POST', { title: 'Disposable unknown receipt', mode: 'playground' }), 201)
    const reservation = await admin.rpc('reserve_sandbox_session', { p_user_id: a.id, p_project_id: pending.id, p_ports: [3000] })
    if (reservation.error || !reservation.data) throw new Error('Reservation unavailable.')
    const name = `codetutor-${reservation.data}`
    names.add(name)
    await Sandbox.create({ name, persistent: false, timeout: 180_000, ...getSandboxCredentials(), signal: AbortSignal.timeout(45_000) })
    // Simulate the provider creating the VM but the app losing its receipt.
    const failed = await admin.from('sandbox_sessions').update({ status: 'failed' }).eq('id', reservation.data).eq('user_id', a.id)
    if (failed.error) throw new Error('Failed-creation simulation unavailable.')
    const unknown = await admin.from('sandbox_sessions').select('sandbox_id').eq('id', reservation.data).single()
    expect(unknown.data?.sandbox_id).toBeNull()
    expect((await admin.rpc('reserve_sandbox_session', { p_user_id: a.id, p_project_id: pending.id, p_ports: [3000] })).error?.message).toBe('PROJECT_SANDBOX_ACTIVE')
    expect(await processSandboxCleanup(reservation.data)).toBe('stopped')
    expect(await inspect(reservation.data)).toMatchObject({ state: 'complete', outcome: 'stopped' })
    await confirmStopped(name)
    console.log('PASS: authenticated deletion, post-response cleanup, ownership/CSRF denial, unknown-receipt shutdown and retained quotas.')
  } finally {
    const errors: string[] = []
    if (users.length) {
      const jobs = await admin.from('sandbox_cleanup_jobs').select('sandbox_name').in('user_id', users)
      if (jobs.error) errors.push('handle lookup')
      else jobs.data.forEach(job => names.add(job.sandbox_name))
    }
    for (const name of names) {
      try {
        const box = await Sandbox.get({ name, resume: false, ...getSandboxCredentials(), signal: AbortSignal.timeout(10_000) })
        if (box.status !== 'stopped') expect((await box.stop({ signal: AbortSignal.timeout(15_000) })).status).toBe('stopped')
      } catch (error) { if (!isSandboxUnavailableError(error)) errors.push('VM stop') }
    }
    for (const client of clients) { try { if ((await client.auth.signOut({ scope: 'global' })).error) errors.push('sign-out') } catch { errors.push('sign-out') } }
    for (const id of users) { try { if ((await admin.auth.admin.deleteUser(id)).error) errors.push('account removal') } catch { errors.push('account removal') } }
    // Incomplete jobs are deliberately retained for the scheduler; do not erase
    // the only provider handle just because the test itself failed.
    if (users.length) {
      const removed = await admin.from('sandbox_cleanup_jobs').delete().in('user_id', users).eq('state', 'complete')
      if (removed.error) errors.push('completed fixture metadata')
    }
    if (errors.length) throw new Error(`Disposable cleanup needs attention: ${errors.join(', ')}`)
    console.log('Stopped disposable VMs, signed out and removed temporary accounts; incomplete cleanup metadata, if any, is retained.')
  }
}, 180_000)
