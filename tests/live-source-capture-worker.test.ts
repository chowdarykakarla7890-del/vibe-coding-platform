import { expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import { Sandbox } from '@vercel/sandbox'
import { processSourceCapture } from '@/lib/server/source-capture-worker'
import { captureSandboxSource } from '@/lib/sandbox/source-capture'
import { getSandboxCredentials, isSandboxUnavailableError } from '@/ai/sandbox'

vi.mock('server-only', () => ({}))

// Real local HTTP API -> hosted DB -> disposable VMs -> durable worker -> file API.
// The worker is invoked independently of browser/status/log subscriptions. This
// proves worker recovery, not that a production scheduler has been deployed.
it.skipIf(process.env.RUN_LIVE_SOURCE_WORKER !== '1')('persists terminal edits/deletions and preserves concurrent editor conflicts after disconnect', async () => {
  const base = process.env.TEST_APP_URL ?? 'http://localhost:3010'
  if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('Run against the local application only.')
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!
  const secret = process.env.SUPABASE_SECRET_KEY!
  if (!url || !key || !secret) throw new Error('Load Supabase configuration first.')
  const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } })
  const cookies = new Map<string, string>()
  const client = createServerClient(url, key, { cookies: {
    getAll: () => [...cookies].map(([name, value]) => ({ name, value })),
    setAll: (values) => values.forEach(({ name, value }) => cookies.set(name, value)),
  } })
  let userId: string | undefined, sandboxId: string | undefined
  const createdSandboxes: string[] = []
  async function request(path: string, method = 'GET', body?: unknown) {
    return fetch(new URL(path, base), { method, redirect: 'manual', signal: AbortSignal.timeout(65_000),
      headers: { cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
        'X-CodeTutor-Account': userId!, ...(method !== 'GET' ? { origin: base, 'content-type': 'application/json' } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }
  async function body(response: Response, status = 200) {
    const result = await response.json()
    if (response.status !== status) throw new Error(`Live capture API failed (${response.status}, ${result.error?.code ?? 'unknown'}).`)
    return result
  }
  async function command(text: string) {
    return (await body(await request(`/api/sandboxes/${sandboxId}/terminal`, 'POST', { command: text }))).cmdId as string
  }
  async function waitForCapture(cmdId: string) {
    // No HTTP command status/log request: closing the browser must not abandon
    // this job. Invoke the same worker used by the authenticated scheduler.
    const lookup = await admin.from('command_audits').select('id').eq('command_id', cmdId).eq('user_id', userId!).single()
    if (lookup.error) throw new Error('Command capture audit missing.')
    const deadline = Date.now() + 70_000
    while (Date.now() < deadline) {
      await processSourceCapture(lookup.data.id)
      const result = await admin.from('source_capture_jobs').select('state,failure_code').eq('id', lookup.data.id).single()
      if (result.error) throw new Error('Durable capture job missing.')
      if (['done', 'conflicted', 'incomplete', 'expired'].includes(result.data.state)) return result.data
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
    throw new Error('Durable capture did not settle within 70 seconds.')
  }
  try {
    const email = `capture-flow-${randomUUID()}@example.invalid`, password = randomBytes(24).toString('hex')
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true })
    if (created.error) throw new Error('Temporary user creation failed.')
    userId = created.data.user.id
    if ((await client.auth.signInWithPassword({ email, password })).error) throw new Error('Temporary sign-in failed.')
    const { project } = await body(await request('/api/projects', 'POST', { title: 'Disposable terminal recovery flow' }), 201)
    const sandbox = await body(await request('/api/sandboxes', 'POST', { projectId: project.id, ports: [3000], timeout: 600_000 }), 201)
    sandboxId = sandbox.sandboxId
    createdSandboxes.push(sandboxId!)
    for (const path of ['main.ts', 'deleted.ts']) await body(await request(`/api/sandboxes/${sandboxId}/files`, 'PUT', { path, content: 'original' }))

    const id = await command(`node -e "const fs=require('fs');fs.writeFileSync('main.ts','terminal saved');fs.unlinkSync('deleted.ts');fs.writeFileSync('new.ts','new source');fs.writeFileSync('.env','never snapshot')"`)
    const initialCapture = await waitForCapture(id)
    if (initialCapture.state !== 'done') {
      const checkVm = (await Sandbox.get({ name: sandboxId!, resume: false, ...getSandboxCredentials() })).currentSession()
      const check = await captureSandboxSource(checkVm, ['main.ts', 'deleted.ts'])
      console.log('Disposable capture diagnostics', check.entries.map((entry) => ({ path: entry.path, kind: entry.kind,
        pending: entry.pending, baseRevision: entry.baseRevision, reason: entry.kind === 'skipped' ? entry.reason : undefined })))
    }
    expect(initialCapture.state).toBe('done')
    const stored = await body(await request(`/api/projects/${project.id}/files`))
    expect(stored.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'main.ts', content: 'terminal saved', revision: 2 }),
      expect.objectContaining({ path: 'new.ts', content: 'new source', revision: 1 }),
    ]))
    expect(stored.files.some((file: { path: string }) => ['.env', 'deleted.ts'].includes(file.path))).toBe(false)
    expect((await request(`/api/sandboxes/${sandboxId}/files?path=deleted.ts`)).status).toBe(404)
    const vm = (await Sandbox.get({ name: sandboxId!, resume: false, ...getSandboxCredentials() })).currentSession()
    const baseline = await captureSandboxSource(vm, ['deleted.ts'])
    expect(baseline.entries.find((entry) => entry.path === 'main.ts')).toMatchObject({ baseRevision: 2, pending: false })
    expect(baseline.entries.find((entry) => entry.path === 'deleted.ts')).toMatchObject({ baseRevision: 2, baseDigest: null, kind: 'missing' })
    expect((await request(`/api/sandboxes/${sandboxId}/files`, 'PUT', { path: 'main.ts', content: 'stale editor', revision: 1 })).status).toBe(409)

    // Queue survives an initial running scan and gets a post-completion capture.
    const delayed = await command(`node -e "setTimeout(()=>require('fs').writeFileSync('new.ts','delayed terminal edit'),1500)"`)
    expect((await waitForCapture(delayed)).state).toBe('done')
    const delayedRead = await request(`/api/sandboxes/${sandboxId}/files?path=new.ts`)
    expect(await delayedRead.text()).toBe('delayed terminal edit')

    // A newer authoritative editor revision must not be replaced by old VM work.
    await body(await request(`/api/projects/${project.id}/files`, 'PUT', { files: [{ path: 'main.ts', content: 'newer editor version', revision: 2 }] }))
    const conflict = await command(`node -e "require('fs').writeFileSync('main.ts','conflicting terminal version')"`)
    expect((await waitForCapture(conflict)).state).toBe('conflicted')
    const versions = await client.from('source_capture_conflicts').select('captured_content,saved_content').eq('project_id', project.id).eq('path', 'main.ts')
    expect(versions.error).toBeNull()
    expect(versions.data).toEqual([{ captured_content: 'conflicting terminal version', saved_content: 'newer editor version' }])
    // Source changed after all ordinary command captures completed. This fixed
    // fixture bypasses the command queue so only the final Stop scan can save it.
    await vm.runCommand({ cmd: 'node', args: ['-e', "require('fs').writeFileSync('final-only.ts','shutdown source')"], timeoutMs: 5_000, signal: AbortSignal.timeout(10_000) })
    const stopping = await body(await request(`/api/sandboxes/${sandboxId}`, 'DELETE'), 202)
    expect(stopping).toMatchObject({ stopped: false, status: 'stopping', shutdown: { state: 'saving' } })
    expect([409, 410]).toContain((await request(`/api/sandboxes/${sandboxId}/terminal`, 'POST', { command: 'node --version' })).status)
    const stopDeadline = Date.now() + 70_000
    let finalStatus
    while (Date.now() < stopDeadline) {
      await processSourceCapture(stopping.shutdown.jobId)
      finalStatus = await body(await request(`/api/sandboxes/${sandboxId}`))
      if (finalStatus.status === 'stopped') break
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    expect(finalStatus).toMatchObject({ status: 'stopped', shutdown: { saved: true, hasConflicts: true } })
    // A conflict preserves the entire changed batch, including newly created
    // paths, rather than silently splitting a possible rename across versions.
    // Resolve the fixture through the owner's API after the VM is gone, proving
    // these final-only bytes are durable and do not depend on live filesystem reads.
    const reviews = await body(await request(`/api/projects/${project.id}/source-recovery`))
    const finalCopy = reviews.conflicts.find((item: { path: string }) => item.path === 'final-only.ts')
    expect(finalCopy).toBeDefined()
    const reviewPath = `/api/projects/${project.id}/source-recovery/${finalCopy.id}`
    const detail = await body(await request(reviewPath))
    expect(detail).toMatchObject({ conflict: { captured: 'shutdown source' }, current: { content: null, revision: 0 }, resolution: null })
    const decision = { choice: 'captured', revision: detail.current.revision }
    const receipt = await body(await request(reviewPath, 'POST', decision))
    expect(receipt).toMatchObject({ path: 'final-only.ts', choice: 'captured', revision: 1, deleted: false })
    expect(await body(await request(reviewPath, 'POST', decision))).toMatchObject(receipt)
    expect(await (await request(`/api/sandboxes/${sandboxId}/files?path=final-only.ts`)).text()).toBe('shutdown source')
    const expiredRead = await request(`/api/sandboxes/${sandboxId}/files?path=new.ts`)
    expect(expiredRead.status).toBe(200)
    expect(await expiredRead.text()).toBe('delayed terminal edit')
    const savedFiles = (await body(await request(`/api/projects/${project.id}/files`))).files
    const replacement = await body(await request('/api/sandboxes', 'POST', { projectId: project.id, ports: [3000], timeout: 600_000 }), 201)
    sandboxId = replacement.sandboxId
    createdSandboxes.push(sandboxId!)
    await body(await request(`/api/sandboxes/${sandboxId}/snapshot`, 'PUT', { files: savedFiles }))
    expect(await (await request(`/api/sandboxes/${sandboxId}/files?path=final-only.ts`)).text()).toBe('shutdown source')
    const restored = (await Sandbox.get({ name: sandboxId!, resume: false, ...getSandboxCredentials() })).currentSession()
    const check = await restored.runCommand({ cmd: 'node', args: ['-e', "if(require('fs').readFileSync('final-only.ts','utf8')!=='shutdown source')process.exit(1)"], timeoutMs: 5_000, signal: AbortSignal.timeout(10_000) })
    expect(check.exitCode).toBe(0)
    console.log('PASS: terminal capture -> conflicting copies -> final Stop capture -> expired-source read -> replacement restore.')
  } finally {
    try {
      for (const sandboxId of createdSandboxes) {
        try {
          const sandbox = await Sandbox.get({ name: sandboxId, resume: false, ...getSandboxCredentials(), signal: AbortSignal.timeout(10_000) })
          let vm
          try { vm = sandbox.currentSession() } catch { /* already stopped */ }
          if (vm && ['running', 'pending'].includes(vm.status)) await vm.stop({ signal: AbortSignal.timeout(10_000) })
        } catch (error) { if (!isSandboxUnavailableError(error)) throw error }
      }
    } finally {
      await client.auth.signOut().catch(() => undefined)
      if (userId && (await admin.auth.admin.deleteUser(userId)).error) throw new Error('Temporary capture account cleanup failed.')
    }
    console.log('Stopped disposable capture VM and removed its test account.')
  }
}, 240_000)
