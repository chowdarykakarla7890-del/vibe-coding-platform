// Hosted database protocol check; no VM, AI request or email. Synthetic account
// fixtures are signed out and deleted in finally, including assertion failures.
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
const secret = process.env.SUPABASE_SECRET_KEY
if (!url || !key || !secret) throw new Error('Load the configured Supabase environment first.')
const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } })
const users = [], clients = []
const hash = text => createHash('sha256').update(text).digest('hex')
async function ok(query) { const r = await query; if (r.error) throw new Error(`Database check failed (${r.error.code ?? 'unknown'}).`); return r.data }
async function account() {
  const email = `shutdown-${randomUUID()}@example.invalid`, password = randomBytes(24).toString('hex')
  const { user } = await ok(admin.auth.admin.createUser({ email, password, email_confirm: true }))
  users.push(user.id)
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  clients.push(client)
  await ok(client.auth.signInWithPassword({ email, password }))
  return { id: user.id, client }
}
const inspect = id => ok(admin.from('source_capture_jobs').select('*').eq('id', id).single())
const claim = id => ok(admin.rpc('claim_source_capture', { p_job_id: id }))
const advance = (job, action) => admin.rpc('advance_sandbox_shutdown', { p_job_id: job.id, p_lease_token: job.lease_token, p_action: action })
const file = { kind: 'file', path: 'main.ts', content: 'terminal final', digest: hash('terminal final'), baseRevision: 1, baseDigest: hash('original'), pending: false }
const capture = entries => ({ entries, complete: entries.every(e => e.kind !== 'skipped' && !e.pending), totalBytes: entries.reduce((n, e) => n + (e.content ? Buffer.byteLength(e.content) : 0), 0), excluded: 0 })
const reconcile = (job, entries) => admin.rpc('reconcile_source_capture', { p_job_id: job.id, p_lease_token: job.lease_token, p_capture: capture(entries), p_terminal: true })
try {
  const a = await account(), b = await account()
  async function fixture() {
    const project = await ok(admin.from('projects').insert({ user_id: a.id, title: 'Disposable shutdown protocol' }).select('id').single())
    const session = await ok(admin.from('sandbox_sessions').insert({ project_id: project.id, user_id: a.id, sandbox_id: `test-only-${randomUUID()}`, status: 'running', expires_at: new Date(Date.now() + 3600000).toISOString() }).select('*').single())
    await ok(admin.rpc('save_source_revision_batch', { p_user_id: a.id, p_project_id: project.id, p_files: [{ path: 'main.ts', content: 'original', revision: 0 }] }))
    return { project, session }
  }
  const { project, session } = await fixture()
  const begin = (owner = a.id) => admin.rpc('begin_sandbox_shutdown', { p_user_id: owner, p_sandbox_id: session.sandbox_id })
  const command = await ok(admin.rpc('reserve_command_execution', { p_user_id: a.id, p_session_id: session.id, p_request_id: randomUUID(), p_executable: 'node', p_origin: 'terminal', p_background: true }))
  assert(command.id)
  const precedingCapture = await claim(command.id)
  assert(precedingCapture?.lease_token)
  assert.equal((await begin(b.id)).error?.message, 'SANDBOX_NOT_FOUND')
  const starts = await Promise.all(Array.from({ length: 6 }, () => ok(begin())))
  assert.equal(new Set(starts).size, 1, 'Concurrent Stop requests share exactly one final capture')
  const id = starts[0]
  const state = await inspect(id)
  assert.equal(state.purpose, 'shutdown'); assert.equal(state.command_audit_id, null)
  assert.equal(await claim(id), null, 'A preceding account capture can defer the initial shutdown claim')
  assert.equal((await inspect(id)).state, 'queued', 'A deferred shutdown remains durable and needs another dispatch')
  // Release only this synthetic lease, simulating the previous worker finishing.
  // No real command or VM is involved in this database protocol fixture.
  await ok(admin.from('source_capture_jobs').update({ lease_token: null, lease_until: null, state: 'queued',
    available_at: new Date(Date.now() + 60000).toISOString() }).eq('id', command.id).eq('user_id', a.id))
  assert.equal((await ok(admin.from('command_audits').select('id').eq('user_id', a.id))).length, 1, 'Stop must not invent a learner command')
  assert.equal((await ok(admin.from('sandbox_sessions').select('status').eq('id', session.id).single())).status, 'stopping')
  assert.equal((await ok(admin.rpc('reserve_command_execution', { p_user_id: a.id, p_session_id: session.id, p_request_id: randomUUID(), p_executable: 'node', p_origin: 'terminal', p_background: false }))).code, 'SANDBOX_EXPIRED')
  assert.equal((await ok(b.client.from('source_capture_jobs').select('id').eq('id', id))).length, 0)
  assert.equal((await ok(a.client.from('source_capture_jobs').select('id').eq('id', id))).length, 1)
  for (const client of [a.client, b.client, createClient(url, key)]) {
    assert((await client.rpc('begin_sandbox_shutdown', { p_user_id: a.id, p_sandbox_id: session.sandbox_id })).error)
    assert((await client.rpc('advance_sandbox_shutdown', { p_job_id: id, p_lease_token: randomUUID(), p_action: 'stopped' })).error)
  }
  const job = await claim(id)
  assert.equal(job.id, id)
  assert.equal(await claim(id), null)
  assert.equal(await ok(advance({ ...job, lease_token: randomUUID() }, 'quiesced')), false)
  assert.equal((await ok(admin.from('command_audits').select('status').eq('id', command.id).single())).status, 'starting')
  assert.equal((await reconcile(job, [file])).error?.message, 'SHUTDOWN_NOT_QUIESCED')
  assert.equal((await ok(admin.from('source_files').select('content').eq('project_id', project.id).single())).content, 'original', 'An invalid final-capture claim rolls source back')
  assert.equal((await advance(job, 'ready')).error?.message, 'SHUTDOWN_SOURCE_NOT_SAVED')
  await ok(advance(job, 'quiesced'))
  assert.equal((await ok(admin.from('command_audits').select('status').eq('id', command.id).single())).status, 'cancelled')
  assert.equal((await advance(job, 'stopped')).error?.message, 'SHUTDOWN_SOURCE_NOT_SAVED')
  await ok(reconcile(job, [file]))
  assert.equal(await ok(advance(job, 'ready')), true)
  // Lost Stop receipt: preserve the saved checkpoint, then reclaim and finish.
  await ok(advance(job, 'retry'))
  await ok(admin.from('source_capture_jobs').update({ available_at: new Date(0).toISOString() }).eq('id', id))
  const retried = await claim(id)
  assert.equal(retried.state, 'acknowledging'); assert.equal(retried.capture_complete, true)
  assert.equal(await ok(advance(job, 'stopped')), false, 'Old worker lease cannot finalize a replacement claim')
  await ok(advance(retried, 'stopped'))
  assert.equal((await inspect(id)).state, 'done')
  assert.equal((await ok(admin.from('sandbox_sessions').select('status').eq('id', session.id).single())).status, 'stopped')
  assert.equal(await ok(begin()), id)
  assert.equal((await ok(admin.from('source_files').select('content').eq('project_id', project.id).single())).content, 'terminal final')

  const partial = await fixture()
  const partialId = await ok(admin.rpc('begin_sandbox_shutdown', { p_user_id: a.id, p_sandbox_id: partial.session.sandbox_id }))
  const partialJob = await claim(partialId)
  await ok(advance(partialJob, 'quiesced'))
  await ok(reconcile(partialJob, [{ path: 'large.ts', kind: 'skipped', reason: 'too-large', baseRevision: 0, baseDigest: null, pending: false }]))
  assert.equal((await advance(partialJob, 'ready')).error?.message, 'SHUTDOWN_SOURCE_NOT_SAVED')
  await ok(advance(partialJob, 'incomplete'))
  assert.equal((await inspect(partialId)).retry_state, 'capturing')
  assert.equal((await ok(admin.from('sandbox_sessions').select('status').eq('id', partial.session.id).single())).status, 'stopping')
  assert.equal(await ok(admin.rpc('begin_sandbox_shutdown', { p_user_id: a.id, p_sandbox_id: partial.session.sandbox_id })), partialId)
  const resumed = await claim(partialId)
  assert.equal(resumed.state, 'capturing')
  await ok(advance(resumed, 'expired'))
  assert.equal((await inspect(partialId)).state, 'expired', 'Natural expiry does not invent a successful final save')

  const closed = await fixture()
  const closedId = await ok(admin.rpc('begin_sandbox_shutdown', { p_user_id: a.id, p_sandbox_id: closed.session.sandbox_id }))
  const closedJob = await claim(closedId)
  await ok(advance(closedJob, 'quiesced')); await ok(reconcile(closedJob, [file]))
  await ok(advance(closedJob, 'expired'))
  assert.equal((await inspect(closedId)).state, 'done', 'Expiration after durable capture preserves the save receipt')

  // Repeated provider failures pause without losing the final-save checkpoint.
  const failing = await fixture()
  const failingId = await ok(admin.rpc('begin_sandbox_shutdown', { p_user_id: a.id, p_sandbox_id: failing.session.sandbox_id }))
  let failingJob = await claim(failingId)
  await ok(advance(failingJob, 'quiesced')); await ok(reconcile(failingJob, [file]))
  for (let attempt = 1; attempt <= 12; attempt++) {
    await ok(advance(failingJob, 'retry'))
    const checkpoint = await inspect(failingId)
    assert.equal(checkpoint.failures, attempt)
    assert.equal(checkpoint.capture_complete, true)
    assert.equal(checkpoint.state, attempt === 12 ? 'incomplete' : 'acknowledging')
    assert(Date.parse(checkpoint.available_at) - Date.parse(checkpoint.updated_at) <= 60000)
    if (attempt < 12) {
      await ok(admin.from('source_capture_jobs').update({ available_at: new Date(0).toISOString() }).eq('id', failingId))
      failingJob = await claim(failingId)
    }
  }
  assert.equal(await claim(failingId), null)
  assert.equal((await inspect(failingId)).retry_state, 'acknowledging')
  await ok(admin.rpc('begin_sandbox_shutdown', { p_user_id: a.id, p_sandbox_id: failing.session.sandbox_id }))
  const finalRetry = await claim(failingId)
  assert.equal(finalRetry.state, 'acknowledging'); assert.equal(finalRetry.failures, 0)
  await ok(advance(finalRetry, 'stopped'))

  // Simulate process death using only this fixture's lease, never another job.
  const crashed = await fixture()
  const crashedId = await ok(admin.rpc('begin_sandbox_shutdown', { p_user_id: a.id, p_sandbox_id: crashed.session.sandbox_id }))
  let crashedJob = await claim(crashedId)
  for (let attempt = 1; attempt <= 12; attempt++) {
    await ok(admin.from('source_capture_jobs').update({ lease_until: new Date(0).toISOString() }).eq('id', crashedId))
    const next = await claim(crashedId)
    assert.equal(await ok(advance(crashedJob, 'quiesced')), false)
    if (attempt === 12) assert.equal(next, null)
    else { assert.equal(next.failures, attempt); crashedJob = next }
  }
  assert.equal((await inspect(crashedId)).state, 'incomplete')
  assert.equal((await inspect(crashedId)).capture_complete, false)
  await ok(admin.rpc('begin_sandbox_shutdown', { p_user_id: a.id, p_sandbox_id: crashed.session.sandbox_id }))
  const recovered = await claim(crashedId)
  assert.equal(recovered.sandbox_id, crashed.session.sandbox_id)
  assert.equal(recovered.state, 'capturing')
  await ok(advance(recovered, 'quiesced')); await ok(reconcile(recovered, [file])); await ok(advance(recovered, 'stopped'))
  await ok(admin.from('projects').delete().eq('id', project.id))
  assert.equal((await ok(admin.from('source_capture_jobs').select('id').eq('id', id))).length, 0)
  console.log('PASS: Stop ownership/RLS, concurrent idempotency, command gating, final capture fencing, checkpoint retries, twelve-failure/crash pauses, incomplete-source safety, expiry and cascades.')
} finally {
  for (const client of clients) await client.auth.signOut().catch(() => undefined)
  for (const id of users) if ((await admin.auth.admin.deleteUser(id)).error) throw new Error('Disposable shutdown account cleanup failed.')
  console.log('Removed disposable shutdown protocol accounts; no VMs were created.')
}
