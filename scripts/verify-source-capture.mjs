// Hosted database-only capture test. No VM, AI call, or email is created.
// Every test account/project is disposable and removed in finally.
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
const secret = process.env.SUPABASE_SECRET_KEY
if (!url || !key || !secret) throw new Error('Load the configured Supabase environment first.')
const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } })
const users = [], clients = []
const hash = (text) => createHash('sha256').update(text).digest('hex')
const file = (path, content, baseRevision = 0, baseContent = null, pending = false) => ({
  kind: 'file', path, content, digest: hash(content), baseRevision, baseDigest: baseContent === null ? null : hash(baseContent), pending,
})
const missing = (path, baseRevision, baseContent) => ({ kind: 'missing', path, baseRevision, baseDigest: baseContent === null ? null : hash(baseContent), pending: false })
const capture = (entries) => ({ entries, complete: !entries.some((entry) => entry.pending || entry.kind === 'skipped'),
  totalBytes: entries.reduce((bytes, entry) => bytes + (entry.kind === 'file' ? Buffer.byteLength(entry.content) : 0), 0), excluded: 0 })
async function ok(promise) { const result = await promise; assert.equal(result.error, null); return result.data }
async function account() {
  const email = `capture-${randomUUID()}@example.invalid`, password = randomBytes(24).toString('hex')
  const data = await ok(admin.auth.admin.createUser({ email, password, email_confirm: true }))
  users.push(data.user.id)
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  clients.push(client)
  await ok(client.auth.signInWithPassword({ email, password }))
  return { id: data.user.id, client }
}
try {
  const a = await account(), b = await account()
  const project = await ok(admin.from('projects').insert({ user_id: a.id, title: 'Disposable capture checks' }).select('id').single())
  const otherProject = await ok(admin.from('projects').insert({ user_id: b.id, title: 'Other capture owner' }).select('id').single())
  const session = await ok(admin.from('sandbox_sessions').insert({ project_id: project.id, user_id: a.id,
    sandbox_id: `test-only-${randomUUID()}`, status: 'running', expires_at: new Date(Date.now()+3600000).toISOString() }).select('id').single())
  const save = (files) => admin.rpc('save_source_revision_batch', { p_user_id: a.id, p_project_id: project.id, p_files: files })
  const source = async (path) => ok(admin.from('source_files').select('content,revision,deleted').eq('project_id', project.id).eq('path', path).maybeSingle())
  async function job(running = false) {
    const reservation = await ok(admin.rpc('reserve_command_execution', { p_user_id: a.id, p_session_id: session.id,
      p_request_id: randomUUID(), p_executable: 'node', p_origin: 'terminal', p_background: running }))
    assert(reservation.id)
    if (!running) await ok(admin.rpc('finish_command_execution', { p_user_id: a.id, p_reservation_id: reservation.id, p_status: 'done', p_exit_code: 0 }))
    return reservation.id
  }
  const claim = (id) => ok(admin.rpc('claim_source_capture', { p_job_id: id }))
  const reconcile = (leased, entries, terminal = true) => admin.rpc('reconcile_source_capture', {
    p_job_id: leased.id, p_lease_token: leased.lease_token, p_capture: capture(entries), p_terminal: terminal,
  })
  const settle = (leased, action = 'acknowledged') => admin.rpc('settle_source_capture', { p_job_id: leased.id, p_lease_token: leased.lease_token, p_action: action })
  const inspectJob = (id) => ok(admin.from('source_capture_jobs').select('*').eq('id', id).single())
  const due = (id) => ok(admin.from('source_capture_jobs').update({ available_at: new Date(0).toISOString() }).eq('id', id))

  await ok(save([{ path: 'main.ts', content: 'original', revision: 0 }, { path: 'remove.ts', content: 'remove me', revision: 0 }]))
  const first = await job()
  assert.deepEqual((await inspectJob(first)).baseline.map(({ path, revision }) => ({ path, revision })), [
    { path: 'main.ts', revision: 1 }, { path: 'remove.ts', revision: 1 },
  ], 'A durable baseline must exist before any VM command can be launched')
  assert.equal((await ok(a.client.from('source_capture_jobs').select('id').eq('id', first))).length, 1)
  assert.equal((await ok(b.client.from('source_capture_jobs').select('id').eq('id', first))).length, 0)
  for (const name of ['claim_source_capture', 'reconcile_source_capture', 'settle_source_capture']) {
    const args = name === 'claim_source_capture' ? { p_job_id: first } : name === 'reconcile_source_capture'
      ? { p_job_id: first, p_lease_token: randomUUID(), p_capture: capture([]) }
      : { p_job_id: first, p_lease_token: randomUUID(), p_action: 'expired' }
    assert((await a.client.rpc(name, args)).error, `${name} must be server-only`)
  }
  const race = await Promise.all([claim(first), claim(first)])
  assert.equal(race.filter(Boolean).length, 1, 'Only one worker may hold a live lease')
  const leased = race.find(Boolean)
  assert.equal((await reconcile({ ...leased, lease_token: randomUUID() }, [file('main.ts', 'stale worker', 1, 'original')])).error?.message, 'CAPTURE_LEASE_LOST')
  assert.equal((await source('main.ts')).content, 'original')
  const edits = [file('main.ts', 'terminal edit', 1, 'original'), missing('remove.ts', 1, 'remove me'), file('new.ts', 'new source')]
  const receipt = await ok(reconcile(leased, edits))
  assert.deepEqual(receipt.acknowledgements, [
    { path: 'main.ts', revision: 2, digest: hash('terminal edit') },
    { path: 'new.ts', revision: 1, digest: hash('new source') },
    { path: 'remove.ts', revision: 2, digest: null },
  ])
  assert.deepEqual(await ok(reconcile(leased, edits)), receipt, 'Lost RPC receipts must be idempotent')
  assert.equal((await source('remove.ts')).deleted, true)
  assert.equal((await reconcile(leased, [file('main.ts', 'different receipt', 1, 'original')])).error?.message, 'CAPTURE_ALREADY_RECONCILED')
  assert.equal(await ok(settle(leased)), true)
  assert.equal((await inspectJob(first)).state, 'done')
  assert.equal(await ok(settle(leased)), false, 'Released lease cannot settle twice')

  // A paused worker cannot apply its old payload after another worker takes over.
  const abandoned = await job(), oldLease = await claim(abandoned)
  await ok(admin.from('source_capture_jobs').update({ lease_until: new Date(0).toISOString() }).eq('id', abandoned))
  const replacement = await claim(abandoned)
  assert.notEqual(oldLease.lease_token, replacement.lease_token)
  assert.equal((await reconcile(oldLease, [file('new.ts', 'late stale write', 1, 'new source')])).error?.message, 'CAPTURE_LEASE_LOST')
  await ok(reconcile(replacement, [])); await ok(settle(replacement))

  // Concurrent editor save wins CAS; both conflicting versions remain recoverable.
  const conflictJob = await claim(await job())
  await ok(save([{ path: 'main.ts', content: 'editor edit', revision: 2 }]))
  const conflictEntries = [file('main.ts', 'another terminal edit', 2, 'terminal edit'), file('sibling.ts', 'atomic sibling')]
  assert.equal((await ok(reconcile(conflictJob, conflictEntries))).conflicted, true)
  assert.equal((await source('main.ts')).content, 'editor edit')
  assert.equal(await source('sibling.ts'), null, 'A conflicting batch must not partially apply')
  const conflicts = await ok(a.client.from('source_capture_conflicts').select('*').eq('project_id', project.id))
  assert.equal(conflicts.length, 2)
  assert.equal(conflicts.find((entry) => entry.path === 'main.ts').captured_content, 'another terminal edit')
  assert.equal(conflicts.find((entry) => entry.path === 'main.ts').saved_content, 'editor edit')
  assert.equal((await ok(b.client.from('source_capture_conflicts').select('id').eq('project_id', project.id))).length, 0)
  assert((await a.client.from('source_capture_conflicts').update({ resolved_at: new Date().toISOString() }).eq('id', conflicts[0].id)).error)
  assert((await admin.from('source_capture_conflicts').insert({ ...conflicts[0], id: randomUUID(), project_id: otherProject.id, user_id: b.id })).error,
    'Composite FK must reject a capture assigned to another user/project')
  await ok(settle(conflictJob))
  assert.equal((await inspectJob(conflictJob.id)).state, 'conflicted')
  const duplicate = await claim(await job())
  await ok(reconcile(duplicate, conflictEntries)); await ok(settle(duplicate))
  assert.equal((await ok(a.client.from('source_capture_conflicts').select('id').eq('project_id', project.id))).length, 2, 'Retries must not duplicate preserved conflicts')

  // An unchanged stale VM copy must never revert a more recent editor save.
  const unchanged = await claim(await job())
  await ok(reconcile(unchanged, [file('main.ts', 'terminal edit', 2, 'terminal edit'), missing('remove.ts', 2, null)]))
  await ok(settle(unchanged))
  assert.equal((await source('main.ts')).content, 'editor edit')
  const uncertain = await claim(await job())
  const unknown = await ok(reconcile(uncertain, [file('unknown.ts', 'preserve me', null, null, true),
    { kind: 'skipped', path: 'new.ts', reason: 'unsafe', baseRevision: 1, baseDigest: hash('new source'), pending: false }]))
  assert.equal(unknown.complete, false); assert.equal(unknown.conflicted, true)
  assert.equal(await source('unknown.ts'), null); assert.equal((await source('new.ts')).deleted, false)
  await ok(settle(uncertain))

  // Completion during a running scan must cause a final post-completion scan.
  const runningId = await job(true), running = await claim(runningId)
  assert.equal((await reconcile(running, [], true)).error?.message, 'CAPTURE_COMMAND_RUNNING')
  await ok(reconcile(running, [], false))
  await ok(admin.rpc('finish_command_execution', { p_user_id: a.id, p_reservation_id: runningId, p_status: 'done', p_exit_code: 0 }))
  await ok(settle(running))
  assert.equal((await inspectJob(runningId)).state, 'queued')
  await due(runningId)
  const finalScan = await claim(runningId)
  await ok(reconcile(finalScan, [], true)); await ok(settle(finalScan))
  assert.equal((await inspectJob(runningId)).state, 'done')

  const invalid = await claim(await job())
  for (const entry of [file('../secret', 'bad'), file('.env', 'bad'), file('.npmrc', 'bad'), file('.codex/auth.json', 'bad'), file('.local/state/gh/device-id', 'bad'), file('bad.ts', 'bad', 0.5),
    { ...file('wrong.ts', 'body'), digest: hash('not body') }, file('large.ts', 'x'.repeat(262145))]) {
    assert((await reconcile(invalid, [entry])).error, 'Malformed capture must not commit')
  }
  assert.equal(await source('bad.ts'), null)
  await ok(settle(invalid, 'expired'))
  assert.equal((await inspectJob(invalid.id)).state, 'expired')

  const namespace = await claim(await job())
  const ns = await ok(reconcile(namespace, [file('main.ts/child.ts', 'conflicting path')]))
  assert.equal(ns.conflicted, true)
  assert.equal(await source('main.ts/child.ts'), null)
  await ok(settle(namespace))
  const resolve = (id, revision, choice, content) => admin.rpc('resolve_source_conflict', {
    p_user_id: a.id, p_project_id: project.id, p_conflict_id: id, p_revision: revision, p_choice: choice,
    ...(content === undefined ? {} : { p_content: content }),
  })
  const mainConflict = conflicts.find((entry) => entry.path === 'main.ts')
  const siblingConflict = conflicts.find((entry) => entry.path === 'sibling.ts')
  assert((await a.client.rpc('resolve_source_conflict', { p_user_id: a.id, p_project_id: project.id,
    p_conflict_id: mainConflict.id, p_revision: 3, p_choice: 'captured' })).error, 'Resolution RPC is server-only')
  assert.equal((await admin.rpc('resolve_source_conflict', { p_user_id: b.id, p_project_id: project.id,
    p_conflict_id: mainConflict.id, p_revision: 3, p_choice: 'captured' })).error?.message, 'PROJECT_NOT_FOUND')
  assert.equal((await admin.rpc('resolve_source_conflict', { p_user_id: b.id, p_project_id: otherProject.id,
    p_conflict_id: mainConflict.id, p_revision: 3, p_choice: 'captured' })).error?.message, 'SOURCE_REVIEW_NOT_FOUND')
  await ok(save([{ path: 'main.ts', content: 'newer reviewed editor version', revision: 3 }]))
  assert.equal((await resolve(mainConflict.id, 3, 'captured')).error?.message, 'SOURCE_CONFLICT', 'Stale reviews cannot replace later edits')
  assert.equal((await resolve(mainConflict.id, 4, 'merged', 'x'.repeat(262145))).error?.message, 'INVALID_RESOLUTION')
  const choices = await Promise.all([resolve(mainConflict.id, 4, 'captured'), resolve(mainConflict.id, 4, 'merged', 'manual merge')])
  assert.equal(choices.filter((result) => !result.error).length, 1, `Competing resolutions have exactly one winner (${choices.map((result) => result.error?.code ?? 'ok').join(',')})`)
  assert.equal(choices.find((result) => result.error).error.message, 'SOURCE_REVIEW_RESOLVED')
  const chosen = choices.find((result) => !result.error).data
  const expectedContent = chosen.choice === 'captured' ? 'another terminal edit' : 'manual merge'
  assert.equal((await source('main.ts')).content, expectedContent)
  const reviewed = await ok(a.client.from('source_capture_conflicts').select('*').eq('id', mainConflict.id).single())
  assert.equal(reviewed.saved_content, 'editor edit', 'Original saved copy remains preserved')
  assert.equal(reviewed.reviewed_content, 'newer reviewed editor version', 'The exact reviewed newer copy also remains preserved')
  assert.equal(reviewed.captured_content, 'another terminal edit')
  await ok(save([{ path: 'main.ts', content: 'edit after resolution', revision: chosen.revision }]))
  assert.deepEqual(await ok(resolve(mainConflict.id, 4, chosen.choice, chosen.choice === 'merged' ? 'manual merge' : undefined)), chosen,
    'Lost resolution receipts replay without rewriting source')
  assert.equal((await source('main.ts')).content, 'edit after resolution')
  assert.equal((await resolve(mainConflict.id, 4, 'saved')).error?.message, 'SOURCE_REVIEW_RESOLVED')
  const kept = await ok(resolve(siblingConflict.id, 0, 'saved'))
  assert.equal(kept.deleted, true); assert.equal(kept.revision, 0); assert.equal(await source('sibling.ts'), null)
  const reviewedAgain = await claim(await job())
  assert.equal((await ok(reconcile(reviewedAgain, conflictEntries))).conflicted, false, 'An exact reviewed VM version must not recreate its conflict')
  await ok(settle(reviewedAgain))
  assert.equal((await source('main.ts')).content, 'edit after resolution')
  const newVersion = await claim(await job())
  assert.equal((await ok(reconcile(newVersion, [file('main.ts', 'new terminal version', 2, 'terminal edit')]))).conflicted, true,
    'Changed terminal bytes must be reviewed again')
  await ok(settle(newVersion))
  const nsConflict = await ok(a.client.from('source_capture_conflicts').select('id').eq('project_id', project.id).eq('path', 'main.ts/child.ts').single())
  assert.equal((await resolve(nsConflict.id, 0, 'captured')).error?.message, 'SOURCE_PATH_CONFLICT')
  assert.equal((await ok(a.client.from('source_capture_conflicts').select('resolved_at').eq('id', nsConflict.id).single())).resolved_at, null)
  const deletionReview = await claim(await job())
  await ok(reconcile(deletionReview, [missing('main.ts', 2, 'terminal edit')]))
  await ok(settle(deletionReview))
  const deletedConflict = await ok(a.client.from('source_capture_conflicts').select('id').eq('capture_job_id', deletionReview.id).single())
  const currentRevision = (await source('main.ts')).revision
  assert.equal((await ok(resolve(deletedConflict.id, currentRevision, 'captured'))).deleted, true)
  assert.equal((await source('main.ts')).deleted, true)
  console.log('Conflict review ownership, strict revisions, concurrent choices, idempotent retry, preserved copies, deletion and reviewed-version deduplication passed.')
  await ok(admin.from('projects').delete().eq('id', project.id).eq('user_id', a.id))
  assert.equal((await ok(admin.from('source_capture_jobs').select('id').eq('project_id', project.id))).length, 0)
  assert.equal((await ok(admin.from('source_capture_conflicts').select('id').eq('project_id', project.id))).length, 0)
  console.log('Capture queue, leases, CAS, deletions, conflict preservation, completion races, validation, RLS and cascades passed.')
} finally {
  for (const client of clients) await client.auth.signOut().catch(() => undefined)
  for (const id of users) {
    const { error } = await admin.auth.admin.deleteUser(id)
    if (error) throw new Error(`Temporary capture user cleanup failed (${error.status ?? 'unknown'}).`)
  }
}
