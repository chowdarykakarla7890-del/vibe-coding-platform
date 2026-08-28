// Database-only queue checks. Uses disposable users/projects and fake sandbox
// registrations; never launches a VM, sends email, or calls an AI provider.
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
const secret = process.env.SUPABASE_SECRET_KEY
if (!url || !key || !secret) throw new Error('Load the configured Supabase environment first.')
const options = { auth: { persistSession: false, autoRefreshToken: false }, global: {
  fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(init?.signal ? [init.signal] : [])]) }),
} }
const admin = createClient(url, secret, options)
const users = [], clients = []
async function ok(promise) {
  const { data, error } = await promise
  assert.equal(error?.code ?? error?.status, undefined, 'Database check failed (details intentionally omitted)')
  return data
}
async function account() {
  const email = `capture-scheduler-${randomUUID()}@example.invalid`, password = randomBytes(24).toString('hex')
  const { user } = await ok(admin.auth.admin.createUser({ email, password, email_confirm: true }))
  users.push(user.id)
  const client = createClient(url, key, options); clients.push(client)
  await ok(client.auth.signInWithPassword({ email, password }))
  return { id: user.id, client }
}
async function workspace(user) {
  const project = await ok(admin.from('projects').insert({ user_id: user.id, title: 'Disposable scheduler check' }).select('id').single())
  const session = await ok(admin.from('sandbox_sessions').insert({ user_id: user.id, project_id: project.id,
    sandbox_id: `test-only-${randomUUID()}`, status: 'running', expires_at: new Date(Date.now()+3600000).toISOString() }).select('id').single())
  return { user, project, session }
}
async function job(workspace) {
  const row = await ok(admin.from('command_audits').insert({ user_id: workspace.user.id, sandbox_session_id: workspace.session.id,
    request_id: randomUUID(), executable: 'node', origin: 'terminal', background: false, status: 'done', exit_code: 0 }).select('id').single())
  return row.id
}
const claim = (id) => ok(admin.rpc('claim_source_capture', { p_job_id: id }))
const settle = (lease, action = 'expired') => ok(admin.rpc('settle_source_capture', { p_job_id: lease.id, p_lease_token: lease.lease_token, p_action: action }))
const due = (id, patch = {}) => ok(admin.from('source_capture_jobs').update({ available_at: new Date(0).toISOString(), ...patch }).eq('id', id))
const inspect = (id) => ok(admin.from('source_capture_jobs').select('*').eq('id', id).single())

try {
  const a = await account(), b = await account()
  const a1 = await workspace(a), a2 = await workspace(a), b1 = await workspace(b)
  const first = await job(a1), sameAccount = await job(a2), otherAccount = await job(b1)
  const parallel = await Promise.all([claim(first), claim(sameAccount), claim(otherAccount)])
  assert.equal(parallel.slice(0, 2).filter(Boolean).length, 1, 'Two projects for one account must not hold simultaneous capture leases')
  assert(parallel[2], 'A busy account must not block another account')
  const held = parallel.slice(0, 2).find(Boolean)
  const waitingId = held.id === first ? sameAccount : first
  assert.equal(await claim(waitingId), null, 'Direct job dispatch must obey the same account concurrency gate')
  await settle(held); await settle(parallel[2])
  const waiting = await claim(waitingId); assert(waiting)
  await settle(waiting)
  console.log('Same-account serialization and cross-account concurrency passed.')

  const retry = (userId, projectId) => admin.rpc('retry_source_captures', { p_user_id: userId, p_project_id: projectId })
  const failing = await job(a1)
  for (let attempt = 1; attempt <= 12; attempt++) {
    await due(failing)
    const lease = await claim(failing); assert(lease)
    const before = Date.now()
    await settle(lease, 'retry')
    const row = await inspect(failing)
    assert.equal(row.failures, attempt)
    assert.equal(row.lease_token, null)
    const delay = new Date(row.available_at).getTime() - before
    assert(delay >= Math.min(60, 2 ** attempt) * 1000 - 1000 && delay < 65_000, 'Failure retries must have bounded backoff')
  }
  assert.equal((await inspect(failing)).state, 'incomplete')
  assert.equal((await inspect(failing)).retry_state, 'capturing')
  await due(failing)
  assert.equal(await claim(failing), null, 'A paused job must not be retried automatically')
  assert.equal((await retry(b.id, a1.project.id)).error?.message, 'PROJECT_NOT_FOUND')
  assert((await a.client.rpc('retry_source_captures', { p_user_id: a.id, p_project_id: a1.project.id })).error, 'Only the server can authorize retries')
  assert.equal(await ok(retry(a.id, a1.project.id)), 1)
  assert.equal(await ok(retry(a.id, a1.project.id)), 0, 'Repeated Retry must not reset a running cycle')
  const resumed = await claim(failing); assert.equal(resumed.failures, 0); await settle(resumed)

  const abandoned = await job(a1)
  let oldLease
  for (let crash = 0; crash < 12; crash++) {
    const lease = await claim(abandoned); assert(lease)
    oldLease ??= lease
    await due(abandoned, { lease_until: new Date(0).toISOString() })
  }
  assert.equal(await claim(abandoned), null, 'Repeated worker crashes must also exhaust the retry budget')
  assert.equal((await inspect(abandoned)).failures, 12)
  assert.equal(await settle(oldLease), false, 'A crashed worker cannot settle a replacement lease')

  const digest = (content) => createHash('sha256').update(content).digest('hex')
  await ok(admin.rpc('save_source_revision_batch', { p_user_id: a.id, p_project_id: a2.project.id,
    p_files: [{ path: 'main.ts', content: 'original', revision: 0 }] }))
  const ackJob = await job(a2), ackLease = await claim(ackJob)
  const receipt = await ok(admin.rpc('reconcile_source_capture', { p_job_id: ackJob, p_lease_token: ackLease.lease_token, p_terminal: true,
    p_capture: { entries: [{ path: 'main.ts', kind: 'file', content: 'terminal edit', digest: digest('terminal edit'),
      baseRevision: 1, baseDigest: digest('original'), pending: false }], totalBytes: Buffer.byteLength('terminal edit'), complete: true, excluded: 0 } }))
  assert.deepEqual(receipt.acknowledgements, [{ path: 'main.ts', revision: 2, digest: digest('terminal edit') }])
  await due(ackJob, { failures: 11 })
  await settle(ackLease, 'retry')
  const pausedAck = await inspect(ackJob)
  assert.equal(pausedAck.retry_state, 'acknowledging')
  assert.equal(await ok(retry(a.id, a2.project.id)), 1)
  const ackAgain = await claim(ackJob)
  assert.equal(ackAgain.state, 'acknowledging')
  assert.equal(ackAgain.capture_digest, pausedAck.capture_digest)
  assert.deepEqual(ackAgain.acknowledgements, receipt.acknowledgements)
  await settle(ackAgain, 'acknowledged')
  assert.equal((await inspect(ackJob)).state, 'done')
  assert.deepEqual(await ok(admin.from('source_files').select('content,revision').eq('project_id', a2.project.id).eq('path', 'main.ts').single()),
    { content: 'terminal edit', revision: 2 }, 'Retry must preserve the original committed revision without a duplicate source write')

  for (let i = 0; i < 12; i++) await due(await job(a2), { state: 'incomplete', retry_state: 'capturing', failures: 12, failure_code: 'capture_failed' })
  assert.equal(await ok(retry(a.id, a2.project.id)), 10)
  assert.equal(await ok(retry(a.id, a2.project.id)), 2)
  assert.equal(await ok(retry(a.id, a2.project.id)), 0)
  await ok(admin.from('sandbox_sessions').update({ status: 'stopped' }).eq('id', a1.session.id))
  assert.equal((await retry(a.id, a1.project.id)).error?.message, 'SANDBOX_EXPIRED', 'Retries never restart stopped VMs')
  assert.equal((await ok(b.client.from('source_capture_jobs').select('id').eq('project_id', a1.project.id))).length, 0)
  console.log('Bounded backoff, retry exhaustion, crash recovery, ACK checkpoints, owner isolation and stopped-VM refusal passed.')
} finally {
  for (const client of clients) await client.auth.signOut().catch(() => undefined)
  for (const id of users) {
    const { error } = await admin.auth.admin.deleteUser(id)
    if (error) throw new Error(`Temporary scheduler user cleanup failed (${error.status ?? 'unknown'}).`)
  }
}
