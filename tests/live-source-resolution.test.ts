import { expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { setTimeout as pause } from 'node:timers/promises'
import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import { Sandbox, type Session } from '@vercel/sandbox'
import { getSandboxCredentials, isSandboxUnavailableError } from '@/ai/sandbox'
import { processSourceCapture } from '@/lib/server/source-capture-worker'
import { captureSandboxSource } from '@/lib/sandbox/source-capture'
import { gatedCommand } from '@/lib/server/command-guard'
import { applyResolutionReceiptSchema, conflictDetailSchema, recoveryPageSchema, resolutionReceiptSchema } from '@/lib/source-recovery'

vi.mock('server-only', () => ({}))

// Explicit opt-in: rebuilt LOCAL HTTP app, hosted DB, two disposable accounts,
// one short-lived VM. No AI, email, real browser session or existing project.
it.skipIf(process.env.RUN_LIVE_SOURCE_RESOLUTION !== '1')('applies reviewed source through owned HTTP routes without overwriting newer work', async () => {
  const base = process.env.TEST_APP_URL ?? 'http://localhost:3112'
  if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('Use the local application only.')
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, secret = process.env.SUPABASE_SECRET_KEY
  if (!url || !key || !secret) throw new Error('Load the configured Supabase environment.')
  const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false }, global: {
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(init?.signal ? [init.signal] : [])]) }),
  } })
  const users: string[] = [], clients: ReturnType<typeof createServerClient>[] = []
  let sandboxId: string | undefined, vm: Session | undefined
  type Account = { id: string; cookies: Map<string, string> }
  async function account(): Promise<Account> {
    const email = `resolution-check-${randomUUID()}@example.invalid`, password = randomBytes(24).toString('hex')
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true })
    if (created.error || !created.data.user) throw new Error('Disposable user creation failed.')
    users.push(created.data.user.id)
    const cookies = new Map<string, string>()
    const client = createServerClient(url!, key!, { global: {
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(init?.signal ? [init.signal] : [])]) }),
    }, cookies: {
      getAll: () => [...cookies].map(([name, value]) => ({ name, value })),
      setAll: values => values.forEach(({ name, value }) => cookies.set(name, value)),
    } })
    clients.push(client)
    if ((await client.auth.signInWithPassword({ email, password })).error) throw new Error('Disposable sign-in failed.')
    return { id: created.data.user.id, cookies }
  }
  async function request(path: string, account?: Account, method = 'GET', body?: unknown, origin = base) {
    return fetch(new URL(path, base), { method, redirect: 'manual', signal: AbortSignal.timeout(65_000),
      headers: { ...(account ? { cookie: [...account.cookies].map(([name, value]) => `${name}=${value}`).join('; '), 'X-CodeTutor-Account': account.id } : {}),
        ...(method !== 'GET' ? { origin, 'content-type': 'application/json' } : {}) },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    })
  }
  async function body(response: Response, expected = 200) {
    const value = await response.json()
    if (response.status !== expected) throw new Error(`Source application API returned ${response.status}, ${value.error?.code ?? 'unknown'} (expected ${expected}).`)
    expect(response.headers.get('x-request-id')).toBeTruthy()
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    return value
  }
  async function captureCommand(account: Account, cmdId: string) {
    const audit = await admin.from('command_audits').select('id').eq('command_id', cmdId).eq('user_id', account.id).single()
    if (audit.error) throw new Error('Disposable command audit missing.')
    const end = Date.now() + 65_000
    while (Date.now() < end) {
      await processSourceCapture(audit.data.id)
      const job = await admin.from('source_capture_jobs').select('state').eq('id', audit.data.id).single()
      if (job.error) throw new Error('Disposable capture job missing.')
      if (['done', 'conflicted', 'incomplete', 'expired'].includes(job.data.state)) return job.data.state
      await pause(1_000)
    }
    throw new Error('Source capture did not settle within its test deadline.')
  }
  async function liveFile(path: string) {
    const file = await vm!.readFileToBuffer({ path }, { signal: AbortSignal.timeout(10_000) })
    return file?.toString('utf8') ?? null
  }
  try {
    const a = await account(), b = await account()
    const { project } = await body(await request('/api/projects', a, 'POST', { title: 'Disposable resolution integration' }), 201)
    const created = await body(await request('/api/sandboxes', a, 'POST', { projectId: project.id, ports: [3000], timeout: 600_000 }), 201)
    sandboxId = created.sandboxId
    vm = (await Sandbox.get({ name: sandboxId!, resume: false, ...getSandboxCredentials(), signal: AbortSignal.timeout(10_000) })).currentSession()
    const paths = ['main.ts', 'changed.ts', 'obsolete.ts', 'deleted.ts']
    for (const path of paths) await body(await request(`/api/sandboxes/${sandboxId}/files`, a, 'PUT', { path, content: 'original' }))
    const snapshot = `/api/sandboxes/${sandboxId}/snapshot`
    expect((await body(await request(snapshot, a, 'POST', { paths: ['main.ts', 'main.ts', 'missing.ts'] })))).toMatchObject({
      files: [{ path: 'main.ts', content: 'original' }], totalBytes: 8, complete: false,
      skipped: [{ path: 'missing.ts', reason: 'not-found' }],
    })
    await body(await request(snapshot, undefined, 'POST', { paths: ['main.ts'] }), 401)
    await body(await request(snapshot, b, 'POST', { paths: ['main.ts'] }), 404)
    await body(await request(snapshot, a, 'POST', { paths: ['main.ts'] }, 'https://wrong.example'), 403)
    await body(await request(`/api/sandboxes/${sandboxId}/files?path=main.ts`, b), 404)
    for (const invalid of ['{', { files: [{ path: '../secret', content: '' }] }, { files: [], forged: true }]) {
      await body(await request(snapshot, a, 'PUT', invalid), 400)
    }
    console.log('PASS: live snapshot deduplication, missing-file receipts, authentication, cross-user denial and strict restore validation.')
    // Saved edits advance separately from the VM; the following command must
    // preserve both versions instead of overwriting this authoritative source.
    await body(await request(`/api/projects/${project.id}/files`, a, 'PUT', { files: paths.map(path => ({ path, content: 'saved editor', revision: 1 })) }))
    const command = await body(await request(`/api/sandboxes/${sandboxId}/terminal`, a, 'POST', {
      command: `node -e "const fs=require('fs');for(const p of ['main.ts','changed.ts','obsolete.ts'])fs.writeFileSync(p,'captured terminal');fs.unlinkSync('deleted.ts');fs.writeFileSync('stray.ts','untracked terminal')"`,
    }))
    expect(await captureCommand(a, command.cmdId)).toBe('conflicted')
    const baseReview = `/api/projects/${project.id}/source-recovery`
    const page = recoveryPageSchema.parse(await body(await request(baseReview, a)))
    expect(page.unresolved).toBe(5)
    const reviews = new Map(page.conflicts.map(item => [item.path, item.id]))
    const review = (path: string) => `${baseReview}/${reviews.get(path)!}`
    const apply = (path: string, revision = 3, user: Account | undefined = a) => request(`${review(path)}/apply`, user, 'POST', { sandboxId, revision })
    for (const path of [...paths, 'stray.ts']) {
      const detail = conflictDetailSchema.parse(await body(await request(review(path), a)))
      const choice = path === 'deleted.ts' ? 'captured' : path === 'stray.ts' ? 'saved' : 'merged'
      const receipt = resolutionReceiptSchema.parse(await body(await request(review(path), a, 'POST', {
        choice, revision: detail.current.revision, ...(choice === 'merged' ? { content: 'reviewed merge 😀' } : {}),
      })))
      expect(receipt).toMatchObject({ revision: path === 'stray.ts' ? 0 : 3, deleted: ['deleted.ts', 'stray.ts'].includes(path) })
    }
    expect((await request(`${review('main.ts')}/apply`, undefined, 'POST', { sandboxId, revision: 3 })).status).toBe(401)
    expect((await apply('main.ts', 3, b)).status).toBe(404)
    expect((await request(`${review('main.ts')}/apply`, a, 'POST', { sandboxId, revision: 3 }, 'https://wrong.example')).status).toBe(403)
    for (const input of ['{', { sandboxId, revision: 3, content: 'forged' }, { sandboxId: '../other', revision: 3 }]) {
      expect((await body(await request(`${review('main.ts')}/apply`, a, 'POST', input), 400)).error.requestId).toBeTruthy()
    }
    console.log('PASS: real conflict capture, saved resolutions, authentication, cross-user denial, CSRF and strict application bodies.')

    const background = await body(await request(`/api/sandboxes/${sandboxId}/terminal`, a, 'POST', { command: 'node -e "setInterval(()=>{},1000)"', background: true }))
    expect((await body(await apply('main.ts'), 409)).error.code).toBe('SOURCE_COMMANDS_RUNNING')
    expect(await liveFile('main.ts')).toBe('captured terminal')
    await body(await request(`/api/sandboxes/${sandboxId}/cmds/${background.cmdId}`, a, 'DELETE'))
    await captureCommand(a, background.cmdId)
    const applied = applyResolutionReceiptSchema.parse(await body(await apply('main.ts')))
    expect(applied).toMatchObject({ path: 'main.ts', revision: 3, deleted: false, sandboxId })
    expect(await liveFile('main.ts')).toBe('reviewed merge 😀')
    expect(applyResolutionReceiptSchema.parse(await body(await apply('main.ts')))).toEqual(applied)
    expect(await liveFile('main.ts')).toBe('reviewed merge 😀')
    console.log('PASS: running background commands exclude application; Stop releases the lock; exact Unicode source and receipt retries succeed.')

    // Fixed disposable fixture: bypass automatic recapture so the application
    // endpoint itself must detect a post-review file change, not a newer review.
    const changed = await vm.runCommand({ ...gatedCommand('node', ['-e', "require('fs').writeFileSync('changed.ts','newer terminal')"]), timeoutMs: 5_000, signal: AbortSignal.timeout(10_000) })
    expect(changed.exitCode).toBe(0)
    expect((await body(await apply('changed.ts'), 409)).error.code).toBe('SOURCE_WORKSPACE_CHANGED')
    expect(await liveFile('changed.ts')).toBe('newer terminal')
    await body(await request(`/api/projects/${project.id}/files`, a, 'PUT', { files: [{ path: 'obsolete.ts', content: 'newer saved', revision: 3 }] }))
    expect((await body(await apply('obsolete.ts'), 409)).error.code).toBe('SOURCE_SUPERSEDED')
    expect(await liveFile('obsolete.ts')).toBe('captured terminal')
    expect(applyResolutionReceiptSchema.parse(await body(await apply('deleted.ts'))).deleted).toBe(true)
    expect(applyResolutionReceiptSchema.parse(await body(await apply('stray.ts', 0))).deleted).toBe(true)
    expect(await liveFile('stray.ts')).toBeNull()
    expect(await liveFile('deleted.ts')).toBeNull()
    const journal = await captureSandboxSource(vm, paths)
    expect(journal.entries.find(item => item.path === 'main.ts')).toMatchObject({ baseRevision: 3, pending: false, content: 'reviewed merge 😀' })
    expect(journal.entries.find(item => item.path === 'deleted.ts')).toMatchObject({ baseRevision: 3, baseDigest: null, kind: 'missing' })
    console.log('PASS: changed terminal bytes and newer saved revisions are refused; deletions and protected revision journals agree.')

    await vm.stop({ signal: AbortSignal.timeout(15_000) })
    expect((await body(await apply('main.ts'), 410)).error.code).toBe('SANDBOX_EXPIRED')
    const retained = await request(`/api/sandboxes/${sandboxId}/files?path=main.ts`, a)
    expect(retained.status).toBe(200); expect(await retained.text()).toBe('reviewed merge 😀')
    expect(retained.headers.get('x-source-revision')).toBe('3')
    expect(retained.headers.get('cache-control')).toBe('private, no-store')
    await body(await request(snapshot, a, 'POST', { paths: ['main.ts'] }), 410)
    await body(await request(snapshot, a, 'PUT', { files: [{ path: 'new.ts', content: 'must not write' }] }), 410)
    const originals = conflictDetailSchema.parse(await body(await request(review('main.ts'), a)))
    expect(originals).toMatchObject({ conflict: { captured: 'captured terminal' }, current: { content: 'saved editor' }, resolution: { revision: 3 } })
    console.log('PASS: expired VM refuses application without resuming; saved source and original comparisons remain readable.')
  } finally {
    const cleanupErrors: string[] = []
    // Discover a possibly-created VM from this test's exact user IDs even if
    // creation's response was lost. Never enumerate or stop unrelated VMs.
    const names = new Set(sandboxId ? [sandboxId] : [])
    if (users.length) {
      try {
        const sessions = await admin.from('sandbox_sessions').select('id,sandbox_id').in('user_id', users)
        if (sessions.error) cleanupErrors.push('session lookup')
        else sessions.data.forEach(item => names.add(item.sandbox_id ?? `codetutor-${item.id}`))
      } catch { cleanupErrors.push('session lookup') }
    }
    for (const name of names) {
      try {
        const sandbox = await Sandbox.get({ name, resume: false, ...getSandboxCredentials(), signal: AbortSignal.timeout(10_000) })
        let session
        try { session = sandbox.currentSession() } catch { /* already stopped */ }
        if (session && ['running', 'pending'].includes(session.status)) await session.stop({ signal: AbortSignal.timeout(15_000) })
      } catch (error) { if (!isSandboxUnavailableError(error)) cleanupErrors.push('VM stop') }
    }
    for (const client of clients) {
      try { if ((await client.auth.signOut({ scope: 'global' })).error) cleanupErrors.push('sign-out') }
      catch { cleanupErrors.push('sign-out') }
    }
    for (const id of users) {
      try { if ((await admin.auth.admin.deleteUser(id)).error) cleanupErrors.push('user deletion') }
      catch { cleanupErrors.push('user deletion') }
    }
    if (cleanupErrors.length) throw new Error(`Disposable cleanup needs attention: ${cleanupErrors.join(', ')}.`)
    console.log('Stopped disposable resolution VM, signed out both sessions and removed test accounts/projects.')
  }
}, 300_000)
