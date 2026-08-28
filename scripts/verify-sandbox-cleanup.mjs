// Opt-in hosted DB protocol checks. No VM, email, or AI request is created.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
if (process.env.RUN_SANDBOX_CLEANUP_CHECK !== '1') throw new Error('Set RUN_SANDBOX_CLEANUP_CHECK=1.')
const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
const boundedFetch = (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15000) })
const options = { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: boundedFetch } }
const admin = createClient(url, process.env.SUPABASE_SECRET_KEY, options)
const users = [], clients = []
const deletedUsers = new Set()
async function ok(query) { const r = await query; if (r.error) throw new Error(`Database check failed (${r.error.code}).`); return r.data }
async function account() {
  const email = `cleanup-${randomUUID()}@example.invalid`, password = randomBytes(24).toString('hex')
  const { user } = await ok(admin.auth.admin.createUser({ email, password, email_confirm: true }))
  users.push(user.id)
  const client = createClient(url, key, options); clients.push(client)
  await ok(client.auth.signInWithPassword({ email, password }))
  return { id: user.id, client }
}
const inspect = id => ok(admin.from('sandbox_cleanup_jobs').select('*').eq('id', id).single())
const claim = id => ok(admin.rpc('claim_sandbox_cleanup', { p_job_id: id }))
const settle = (job, outcome) => ok(admin.rpc('settle_sandbox_cleanup', { p_job_id: job.id, p_lease_token: job.lease_token, p_outcome: outcome }))
const due = id => ok(admin.from('sandbox_cleanup_jobs').update({ next_attempt_at: new Date(0).toISOString() }).eq('id', id))
try {
  const a = await account(), b = await account()
  const project = await ok(a.client.from('projects').insert({ user_id: a.id, title: 'Synthetic cleanup protocol' }).select('id').single())
  const reserve = () => admin.rpc('reserve_sandbox_session', { p_user_id: a.id, p_project_id: project.id, p_ports: [3000] })
  const id = await ok(reserve())
  await ok(admin.from('sandbox_sessions').update({ status: 'failed' }).eq('id', id))
  // This reproduces the old leak: marking a failed creation freed its slot
  // even though the provider's shutdown had never been acknowledged.
  assert.equal((await reserve()).error?.message, 'PROJECT_SANDBOX_ACTIVE', 'Unconfirmed cleanup must retain the project slot')
  const row = await inspect(id)
  assert.equal(row.sandbox_name, `codetutor-${id}`); assert.equal(row.state, 'pending')
  for (const client of [a.client, b.client, createClient(url, key, options)]) {
    assert((await client.from('sandbox_cleanup_jobs').select('*')).error, 'Queue metadata is private, even to its former owner')
    assert((await client.from('sandbox_cleanup_jobs').update({ state: 'complete' }).eq('id', id)).error)
    assert((await client.rpc('claim_sandbox_cleanup', { p_job_id: id })).error)
    assert((await client.rpc('settle_sandbox_cleanup', { p_job_id: id, p_lease_token: randomUUID(), p_outcome: 'stopped' })).error)
  }
  const claims = await Promise.all([claim(id), claim(id)])
  assert.equal(claims.filter(Boolean).length, 1)
  const job = claims.find(Boolean)
  assert.equal(await settle({ ...job, lease_token: randomUUID() }, 'stopped'), false)
  assert.equal(await settle(job, 'unavailable'), true)
  assert.equal((await inspect(id)).state, 'pending', 'An early 404 does not prove a late creation cannot arrive')
  assert.equal((await reserve()).error?.message, 'PROJECT_SANDBOX_ACTIVE')
  await due(id)
  const retry = await claim(id)
  assert.equal(await settle(job, 'stopped'), false, 'A stale worker cannot settle a new lease')
  await settle(retry, 'stopped')
  assert.equal((await inspect(id)).state, 'complete')

  const next = await ok(reserve())
  await ok(admin.from('sandbox_sessions').update({ sandbox_id: `codetutor-${next}`, status: 'running', expires_at: new Date(Date.now()+600000).toISOString() }).eq('id', next))
  assert.equal((await inspect(next)).state, 'attached')
  await due(next); assert.equal(await claim(next), null, 'Healthy attached sandboxes are not cleanup candidates')
  // The deletion trigger, not the HTTP request, retains the provider handle.
  assert((await a.client.from('projects').delete().eq('id', project.id)).error, 'Browser deletion remains denied; use the owned API')
  await ok(admin.from('projects').delete().eq('id', project.id).eq('user_id', a.id))
  assert.equal((await inspect(next)).state, 'pending')
  assert.equal((await inspect(next)).reason, 'deleted')
  assert.equal((await ok(admin.from('sandbox_sessions').select('id').eq('id', next))).length, 0)
  const deleted = await claim(next); await settle(deleted, 'stopped')

  const p2 = await ok(admin.from('projects').insert({ user_id: a.id, title: 'Late creation fence' }).select('id').single())
  const late = await ok(admin.rpc('reserve_sandbox_session', { p_user_id: a.id, p_project_id: p2.id, p_ports: [3000] }))
  await due(late)
  const lateJob = await claim(late)
  assert((await admin.from('sandbox_sessions').update({ sandbox_id: `codetutor-${late}`, status: 'running' }).eq('id', late)).error, 'Cleanup fences late attachments')
  await settle(lateJob, 'retry')
  assert((await inspect(late)).next_attempt_at > new Date().toISOString())
  await due(late)
  const dead = await claim(late)
  await ok(admin.from('sandbox_cleanup_jobs').update({ lease_until: new Date(0).toISOString() }).eq('id', late))
  const recovered = await claim(late)
  assert.notEqual(dead.lease_token, recovered.lease_token)
  assert.equal(await settle(dead, 'stopped'), false)
  await ok(admin.from('sandbox_cleanup_jobs').update({ observe_until: new Date(0).toISOString() }).eq('id', late))
  await settle(recovered, 'unavailable')
  assert.equal((await inspect(late)).state, 'complete')

  const quotaProjects = await ok(admin.from('projects').insert([1, 2, 3].map(n => ({ user_id: b.id, title: `Synthetic quota ${n}` }))).select('id'))
  const held = []
  for (const p of quotaProjects.slice(0, 2)) {
    const id = await ok(admin.rpc('reserve_sandbox_session', { p_user_id: b.id, p_project_id: p.id, p_ports: [3000] }))
    held.push(id)
    await ok(admin.from('sandbox_sessions').update({ status: 'failed' }).eq('id', id))
  }
  assert.equal((await admin.rpc('reserve_sandbox_session', { p_user_id: b.id, p_project_id: quotaProjects[2].id, p_ports: [3000] })).error?.message, 'SANDBOX_QUOTA', 'Unconfirmed failures still count across projects')
  await ok(b.client.auth.signOut({ scope: 'global' }))
  await ok(admin.auth.admin.deleteUser(b.id)); deletedUsers.add(b.id)
  for (const id of held) {
    assert.equal((await inspect(id)).reason, 'deleted', 'Account deletion retains the operational handle')
    assert.equal((await inspect(id)).user_id, b.id)
    await settle(await claim(id), 'stopped')
  }
  console.log('PASS: retained project/account quotas, private grants, deduplicated leases, lost workers, delayed visibility, attachment fencing, and project/account deletion-surviving cleanup.')
} finally {
  for (const client of clients) await client.auth.signOut({ scope: 'global' })
  for (const id of users) {
    if (!deletedUsers.has(id)) await ok(admin.auth.admin.deleteUser(id))
    // All handles in this script are synthetic: no provider VM was started.
    const removed = await admin.from('sandbox_cleanup_jobs').delete().eq('user_id', id)
    if (removed.error && removed.error.code !== 'PGRST205') throw new Error('Synthetic cleanup metadata removal failed.')
  }
}
