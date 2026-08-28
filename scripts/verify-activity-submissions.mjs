// Hosted database-only submission tests: no VM, AI request, or email.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const { NEXT_PUBLIC_SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: key, SUPABASE_SECRET_KEY: secret } = process.env
if (!url || !key || !secret) throw new Error('Load the configured Supabase environment first.')
const options = { auth: { persistSession: false, autoRefreshToken: false } }
const admin = createClient(url, secret, options), clients = [], users = []
async function ok(promise) { const r = await promise; assert.equal(r.error, null); return r.data }
async function account() {
  const email = `submission-${randomUUID()}@example.invalid`, password = randomBytes(24).toString('hex')
  const { user } = await ok(admin.auth.admin.createUser({ email, password, email_confirm: true }))
  users.push(user.id)
  const client = createClient(url, key, options); clients.push(client)
  await ok(client.auth.signInWithPassword({ email, password }))
  return { id: user.id, client }
}
const manifest = { id: 'dsa-submission-test', title: 'Immutable submission test', concepts: ['arrays'] }
try {
  const a = await account(), b = await account()
  const project = await ok(admin.from('projects').insert({ user_id: a.id, title: 'Disposable submission test', activity_id: manifest.id, language: 'JavaScript' }).select('id').single())
  const save = (files) => admin.rpc('save_source_revision_batch', { p_user_id: a.id, p_project_id: project.id, p_files: files })
  const args = (id = randomUUID()) => ({ p_user_id: a.id, p_project_id: project.id, p_submission_id: id, p_manifest: manifest, p_language: 'JavaScript', p_model_id: 'test/model' })
  const begin = (input = args()) => admin.rpc('begin_activity_submission', input)
  const finishArgs = (id) => ({ p_user_id: a.id, p_submission_id: id, p_score: 85, p_passed: true, p_ai_assessed: true, p_feedback: ['Synthetic test assessment'], p_verification_kind: 'rubric' })
  const finish = (id) => admin.rpc('record_submission_assessment', finishArgs(id))
  const source = (id) => ok(a.client.from('submission_sources').select('files,digest,byte_size').eq('id', id).single())

  assert.equal((await begin()).error?.message, 'SUBMISSION_SOURCE_MISSING')
  await ok(save([{ path: 'main.js', content: 'original source 😀', revision: 0 }]))
  const firstArgs = args(), first = await ok(begin(firstArgs))
  assert.deepEqual(first.source_versions, [{ path: 'main.js', revision: 1 }])
  assert.deepEqual((await source(first.source_id)).files, [{ path: 'main.js', content: 'original source 😀' }])
  assert.equal((await ok(begin(firstArgs))).id, first.id, 'Lost begin receipts must be idempotent')
  assert.equal((await begin({ ...firstArgs, p_model_id: 'different/model' })).error?.message, 'SUBMISSION_CONFLICT')
  assert.equal((await begin({ ...args(), p_user_id: b.id })).error?.message, 'ACTIVITY_PROJECT_NOT_FOUND')
  assert.equal((await ok(b.client.from('activity_submissions').select('id').eq('id', first.id))).length, 0)
  assert.equal((await ok(b.client.from('submission_sources').select('id').eq('id', first.source_id))).length, 0)
  for (const [fn, input] of [['begin_activity_submission', args()], ['record_submission_assessment', finishArgs(first.id)], ['fail_activity_submission', { p_user_id: a.id, p_submission_id: first.id, p_code: 'TEST_FAILURE' }]]) {
    assert((await a.client.rpc(fn, input)).error, `${fn} must not be callable by a browser`)
  }
  assert((await a.client.from('activity_submissions').update({ state: 'failed' }).eq('id', first.id)).error)
  assert((await a.client.from('submission_sources').update({ files: [] }).eq('id', first.source_id)).error)
  assert.equal((await admin.from('activity_submissions').update({ manifest: { ...manifest, title: 'tampered' } }).eq('id', first.id)).error?.message, 'SUBMISSION_IMMUTABLE')
  assert.equal((await admin.from('submission_sources').update({ byte_size: 42 }).eq('id', first.source_id)).error?.message, 'SUBMISSION_IMMUTABLE')

  const [second, third] = await Promise.all([ok(begin()), ok(begin())])
  assert.equal(second.source_id, first.source_id); assert.equal(third.source_id, first.source_id)
  assert.equal((await ok(admin.from('submission_sources').select('id').eq('project_id', project.id))).length, 1, 'Identical source deduplicates under parallel submissions')
  await ok(save([{ path: 'main.js', content: 'newer edit', revision: 1 }]))
  assert.equal((await source(first.source_id)).files[0].content, 'original source 😀', 'A saved edit cannot replace submitted content')
  const recorded = await ok(finish(first.id))
  assert.equal(recorded.sourceCurrent, false)
  assert.equal((await ok(admin.from('projects').select('status').eq('id', project.id).single())).status, 'active', 'Passing older source cannot mark newer source completed')
  assert.deepEqual(await ok(finish(first.id)), recorded)
  assert.equal((await admin.rpc('record_submission_assessment', { ...finishArgs(first.id), p_score: 90 })).error?.message, 'ASSESSMENT_CONFLICT')
  assert.equal((await admin.rpc('record_submission_assessment', { ...finishArgs(first.id), p_user_id: b.id })).error?.message, 'SUBMISSION_NOT_FOUND')
  assert.equal(await ok(admin.rpc('fail_activity_submission', { p_user_id: a.id, p_submission_id: first.id, p_code: 'LATE_ABORT' })), false)

  const current = await ok(begin())
  const [r1, r2] = await Promise.all([ok(finish(current.id)), ok(finish(current.id))])
  assert.deepEqual(r1, r2); assert.equal(r1.sourceCurrent, true)
  assert.equal((await ok(admin.from('assessments').select('id').eq('submission_id', current.id))).length, 1)
  assert.equal((await ok(admin.from('projects').select('status').eq('id', project.id).single())).status, 'completed')
  await ok(admin.rpc('fail_activity_submission', { p_user_id: a.id, p_submission_id: second.id, p_code: 'RUBRIC_UNAVAILABLE' }))
  assert.equal((await finish(second.id)).error?.message, 'SUBMISSION_CLOSED')
  assert.equal((await ok(admin.from('assessments').select('id').eq('submission_id', second.id))).length, 0)

  // A source save races the snapshot: each result is one complete revision,
  // never a mixed pair from the beginning/end of a batch.
  await ok(save([{ path: 'one.js', content: 'old one', revision: 0 }, { path: 'two.js', content: 'old two', revision: 0 }]))
  const [racing] = await Promise.all([ok(begin()), ok(save([{ path: 'one.js', content: 'new one', revision: 1 }, { path: 'two.js', content: 'new two', revision: 1 }]))])
  const pair = (await source(racing.source_id)).files.filter((f) => f.path !== 'main.js').map((f) => f.content)
  assert(['old one|old two', 'new one|new two'].includes(pair.join('|')), 'Capture must serialize with batch source writes')
  const toDelete = await ok(begin())
  await ok(save([{ path: 'main.js', content: '', revision: 2, deleted: true }]))
  assert.equal((await source(toDelete.source_id)).files.find((f) => f.path === 'main.js').content, 'newer edit', 'Deletion retains the submitted version')
  const afterDelete = await ok(begin())
  assert(!(await source(afterDelete.source_id)).files.some((f) => f.path === 'main.js'))

  // Closed streams remain understandable without manufacturing a learner score.
  const expired = { ...afterDelete, id: randomUUID(), created_at: '2026-01-01T00:00:00Z', expires_at: '2026-01-01T00:05:00Z' }
  delete expired.metadata_bytes
  await ok(admin.from('activity_submissions').insert(expired))
  assert.equal((await finish(expired.id)).error?.message, 'SUBMISSION_CLOSED')
  await ok(begin())
  assert.deepEqual(await ok(admin.from('activity_submissions').select('state,failure_code').eq('id', expired.id).single()),
    { state: 'failed', failure_code: 'SUBMISSION_INTERRUPTED' })
  assert.equal((await ok(admin.from('assessments').select('id').eq('submission_id', expired.id))).length, 0)

  // Registration/audit fixtures only: no command or Sandbox VM is executed.
  const registration = await ok(admin.from('sandbox_sessions').insert({ user_id: a.id, project_id: project.id,
    status: 'expired', sandbox_id: `submission-${randomUUID()}`, expires_at: new Date(Date.now() - 1000).toISOString() }).select('id').single())
  const command = await ok(admin.from('command_audits').insert({ user_id: a.id, sandbox_session_id: registration.id,
    executable: 'node', background: false, status: 'done', exit_code: 0, request_id: randomUUID(), finished_at: new Date().toISOString() }).select('id').single())
  for (const state of ['queued', 'capturing', 'acknowledging']) {
    await ok(admin.from('source_capture_jobs').update({ state }).eq('id', command.id))
    assert.equal((await begin()).error?.message, 'SOURCE_CAPTURE_PENDING', `Submission must wait for ${state} foreground source`)
  }
  await ok(admin.from('command_audits').update({ background: true }).eq('id', command.id))
  await ok(begin()) // A long-lived background server does not block saved-source assessment.
  await ok(admin.from('command_audits').update({ background: false }).eq('id', command.id))
  await ok(admin.from('source_capture_jobs').update({ state: 'done' }).eq('id', command.id))
  await ok(begin())
  const conflict = await ok(admin.from('source_capture_conflicts').insert({ user_id: a.id, project_id: project.id,
    capture_job_id: command.id, path: 'one.js', saved_revision: 2, saved_content: 'new one', fingerprint: 'b'.repeat(64), reason: 'revision_conflict' }).select('id').single())
  assert.equal((await begin()).error?.message, 'SOURCE_REVIEW_REQUIRED')
  await ok(admin.from('source_capture_conflicts').delete().eq('id', conflict.id).eq('user_id', a.id))

  // The metadata count cap is checked even when source is deduplicated.
  const count = (await ok(admin.from('activity_submissions').select('id').eq('project_id', project.id))).length
  const copyableSubmission = { ...afterDelete }
  delete copyableSubmission.metadata_bytes
  const copies = Array.from({ length: 999 - count }, () => ({ ...copyableSubmission, id: randomUUID() }))
  await ok(admin.from('activity_submissions').insert(copies))
  const lastProjectSlot = await Promise.all([begin(), begin(), begin()])
  assert.equal(lastProjectSlot.filter((r) => !r.error).length, 1, 'Exactly one concurrent submission may claim the final project slot')
  assert.equal(lastProjectSlot.filter((r) => r.error?.message === 'SUBMISSION_STORAGE_LIMIT').length, 2)
  assert.equal((await begin()).error?.message, 'SUBMISSION_STORAGE_LIMIT')

  // Fill actual metadata records (not fake counters) to leave one account slot,
  // then race two independent projects. Each project still has its own room.
  let candidateProject
  for (let index = 0; index < 4; index++) {
    const extra = await ok(admin.from('projects').insert({ user_id: a.id, title: 'Disposable quota race', activity_id: manifest.id, language: 'JavaScript' }).select('id').single())
    await ok(admin.rpc('save_source_revision_batch', { p_user_id: a.id, p_project_id: extra.id, p_files: [{ path: 'main.js', content: 'quota fixture', revision: 0 }] }))
    const seed = await ok(begin({ ...args(), p_project_id: extra.id }))
    delete seed.metadata_bytes
    await ok(admin.from('activity_submissions').insert(Array.from({ length: index === 3 ? 998 : 999 }, () => ({ ...seed, id: randomUUID() }))))
    candidateProject = extra.id
  }
  const empty = await ok(admin.from('projects').insert({ user_id: a.id, title: 'Disposable final quota candidate', activity_id: manifest.id, language: 'JavaScript' }).select('id').single())
  await ok(admin.rpc('save_source_revision_batch', { p_user_id: a.id, p_project_id: empty.id, p_files: [{ path: 'main.js', content: 'fresh quota fixture', revision: 0 }] }))
  const lastAccountSlot = await Promise.all([begin({ ...args(), p_project_id: candidateProject }), begin({ ...args(), p_project_id: empty.id })])
  assert.equal(lastAccountSlot.filter((r) => !r.error).length, 1, 'Exactly one project may claim the final account slot')
  assert.equal(lastAccountSlot.filter((r) => r.error?.message === 'SUBMISSION_STORAGE_LIMIT').length, 1)
  const accountCount = await admin.from('activity_submissions').select('id', { count: 'exact', head: true }).eq('user_id', a.id)
  assert.equal(accountCount.error, null); assert.equal(accountCount.count, 5000)
  console.log('Immutable source, deduplication, saved-write races, provenance, idempotence, source-current completion, expired attempts, capture/review gates, metadata quotas and two-user RLS passed.')

  await ok(admin.from('projects').delete().eq('id', project.id).eq('user_id', a.id))
  for (const table of ['activity_submissions', 'submission_sources', 'assessments']) {
    assert.equal((await ok(admin.from(table).select('id').eq('project_id', project.id))).length, 0, `${table} must cascade with project deletion`)
  }
  console.log('Project deletion cascades submission evidence and assessments.')
} finally {
  for (const client of clients) await client.auth.signOut().catch(() => undefined)
  const failures = []
  for (const id of users) { const { error } = await admin.auth.admin.deleteUser(id); if (error) failures.push(error.status ?? 'unknown') }
  if (failures.length) throw new Error(`Temporary submission account cleanup failed (${failures.join(',')}).`)
}
