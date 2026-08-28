// Hosted DB fixtures only. No VMs, AI requests, email, or customer data.
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const { NEXT_PUBLIC_SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: key, SUPABASE_SECRET_KEY: secret } = process.env
if (!url || !key || !secret) throw new Error('Load the configured Supabase environment first.')
const options = { auth: { persistSession: false, autoRefreshToken: false } }
const admin = createClient(url, secret, options), users = [], clients = []
const sha = value => createHash('sha256').update(value).digest('hex')
async function ok(promise) { const r = await promise; if (r.error) throw new Error(`Archive DB check failed (${r.error.code ?? 'unknown'}, ${/^[A-Z_]+$/.test(r.error.message) ? r.error.message : 'database failure'}).`); return r.data }
async function account() {
  const email = `archive-${randomUUID()}@example.invalid`, password = randomBytes(24).toString('hex')
  const { user } = await ok(admin.auth.admin.createUser({ email, password, email_confirm: true })); users.push(user.id)
  const client = createClient(url, key, options); clients.push(client)
  await ok(client.auth.signInWithPassword({ email, password }))
  return { id: user.id, client }
}
async function readAll(owner, project, receipt) {
  let cursor = 0, bytes = 0
  const records = []
  do {
    const page = await ok(admin.rpc('read_project_archive', { p_user_id: owner, p_project_id: project, p_archive_id: receipt.id, p_after: cursor }))
    assert(page.records.length > 0 && page.records.length <= 20)
    assert(Buffer.byteLength(JSON.stringify(page)) < 4_500_000)
    for (const record of page.records) {
      assert.equal(record.index, records.length + 1)
      assert.equal(sha(record.record), record.sha256)
      bytes += Buffer.byteLength(record.record)
      records.push(JSON.parse(record.record))
    }
    cursor = page.nextCursor
  } while (cursor !== null)
  assert.equal(records.length, receipt.recordCount); assert.equal(bytes, receipt.payloadBytes)
  return records
}
try {
  const a = await account(), b = await account()
  const project = await ok(admin.from('projects').insert({ user_id: a.id, title: 'Disposable full archive', activity_id: 'archive-activity', language: 'TypeScript' }).select('id').single())
  const args = { p_user_id: a.id, p_project_id: project.id, p_archive_id: randomUUID(), p_catalog: [{ id: 'archive-activity', title: 'Frozen bundled activity' }] }
  const save = files => ok(admin.rpc('save_source_revision_batch', { p_user_id: a.id, p_project_id: project.id, p_files: files }))
  await save([{ path: 'main.ts', content: 'submitted source 😀', revision: 0 }, { path: 'other.ts', content: 'second file', revision: 0 }])
  const submission = await ok(admin.rpc('begin_activity_submission', { p_user_id: a.id, p_project_id: project.id, p_submission_id: randomUUID(),
    p_manifest: { id: 'archive-activity', title: 'Submitted activity', concepts: ['arrays'] }, p_language: 'TypeScript', p_model_id: 'test/model' }))
  await ok(admin.rpc('record_submission_assessment', { p_user_id: a.id, p_submission_id: submission.id, p_score: 70, p_passed: false, p_ai_assessed: true,
    p_feedback: ['Synthetic review'], p_verification_kind: 'rubric' }))
  const messages = Array.from({ length: 1105 }, (_, i) => ({ user_id: a.id, project_id: project.id, id: randomUUID(), role: 'user', status: 'complete', parts: [{ type: 'text', text: `message ${i}` }] }))
  messages[0].parts.push({ type: 'data-test', data: { sandboxId: 'do-not-export', accessToken: 'capability-sentinel', nested: { refresh_token: 'refresh-sentinel', keep: 'keep-value' } } })
  await ok(admin.from('messages').insert(messages))
  const registration = await ok(admin.from('sandbox_sessions').insert({ user_id: a.id, project_id: project.id, status: 'expired',
    sandbox_id: `test-only-${randomUUID()}`, expires_at: new Date(0).toISOString() }).select('id').single())
  const command = await ok(admin.from('command_audits').insert({ user_id: a.id, sandbox_session_id: registration.id, executable: 'node',
    background: false, status: 'done', exit_code: 0, request_id: randomUUID(), finished_at: new Date().toISOString() }).select('id').single())
  await ok(admin.from('source_capture_jobs').update({ state: 'conflicted' }).eq('id', command.id))
  const conflict = await ok(admin.from('source_capture_conflicts').insert({ user_id: a.id, project_id: project.id, capture_job_id: command.id,
    path: 'main.ts', saved_revision: 1, saved_content: 'submitted source 😀', captured_content: 'terminal conflict', captured_digest: sha('terminal conflict'),
    fingerprint: sha('fixture'), reason: 'revision_conflict' }).select('id').single())
  await ok(admin.from('portfolios').upsert({ user_id: a.id, document: { projects: [{ projectId: project.id, title: 'Selected project', screenshot: 'data:image/png;base64,AA==' }, { projectId: randomUUID(), title: 'Other private project' }] } }))
  assert.equal((await admin.rpc('create_project_archive', { ...args, p_user_id: b.id })).error?.message, 'PROJECT_NOT_FOUND')
  for (const client of [a.client, b.client, createClient(url, key, options)]) {
    assert((await client.rpc('create_project_archive', args)).error)
    assert((await client.rpc('read_project_archive', { p_user_id: a.id, p_project_id: project.id, p_archive_id: args.p_archive_id })).error)
    assert((await client.rpc('delete_project_archive', { p_user_id: a.id, p_project_id: project.id, p_archive_id: args.p_archive_id })).error)
    assert((await client.rpc('purge_project_archives')).error)
  }
  const receipts = await Promise.all(Array.from({ length: 4 }, () => ok(admin.rpc('create_project_archive', args))))
  assert.equal(new Set(receipts.map(r => r.id)).size, 1)
  const receipt = receipts[0]
  // Changes AFTER capture must not leak into any page, even message 1001+.
  await save([{ path: 'main.ts', content: 'new source after capture', revision: 1 }])
  await ok(admin.from('messages').update({ parts: [{ type: 'text', text: 'changed after archive' }] }).eq('id', messages.at(-1).id).eq('user_id', a.id))
  await ok(admin.rpc('resolve_source_conflict', { p_user_id: a.id, p_project_id: project.id, p_conflict_id: conflict.id, p_revision: 2, p_choice: 'saved' }))
  assert.equal((await admin.rpc('read_project_archive', { p_user_id: b.id, p_project_id: project.id, p_archive_id: receipt.id })).error?.message, 'ARCHIVE_NOT_FOUND')
  await ok(admin.rpc('delete_project_archive', { p_user_id: b.id, p_project_id: project.id, p_archive_id: receipt.id }))
  const records = await readAll(a.id, project.id, receipt)
  assert.equal(records.filter(r => r.kind === 'message').length, 1105, 'No default 1000-row truncation')
  assert.equal(records.find(r => r.kind === 'source' && r.data.path === 'main.ts').data.content, 'submitted source 😀')
  assert.equal(records.filter(r => r.kind === 'message').at(-1).data.parts[0].text, 'message 1104')
  assert.equal(records.find(r => r.kind === 'conflict').data.resolvedAt, null)
  assert.equal(records.find(r => r.kind === 'conflict-copy' && r.data.version === 'captured').data.content, 'terminal conflict')
  assert.equal(records.filter(r => r.kind === 'submission-file').length, 2)
  assert.equal(records.find(r => r.kind === 'submission').data.sourceId, submission.source_id)
  assert.equal(records.find(r => r.kind === 'assessment').data.submissionId, submission.id)
  assert.equal(records.find(r => r.kind === 'submission-source').data.fileCount, 2)
  assert.equal(records.find(r => r.kind === 'activity').data.manifest.title, 'Frozen bundled activity')
  assert.equal(records.filter(r => r.kind === 'portfolio-project').length, 1)
  const serialized = JSON.stringify(records)
  for (const sentinel of ['capability-sentinel', 'refresh-sentinel', 'do-not-export', 'Other private project', a.id, b.id]) assert(!serialized.includes(sentinel), 'Structured credentials/account data must be omitted')
  assert(serialized.includes('keep-value'))
  assert.equal((await admin.rpc('read_project_archive', { p_user_id: a.id, p_project_id: project.id, p_archive_id: receipt.id, p_after: -1 })).error?.message, 'INVALID_ARCHIVE_CURSOR')
  await ok(admin.rpc('delete_project_archive', { p_user_id: a.id, p_project_id: project.id, p_archive_id: receipt.id }))
  assert.equal((await admin.rpc('read_project_archive', { p_user_id: a.id, p_project_id: project.id, p_archive_id: receipt.id })).error?.message, 'ARCHIVE_NOT_FOUND')
  assert.equal((await ok(admin.from('messages').select('id', { count: 'exact', head: false }).eq('user_id', a.id).limit(1))).length, 1)
  // Capture racing an atomic batch can see old or new, never a mixed pair.
  await save([{ path: 'one.ts', content: 'old one', revision: 0 }, { path: 'two.ts', content: 'old two', revision: 0 }])
  const [racing] = await Promise.all([ok(admin.rpc('create_project_archive', { ...args, p_archive_id: randomUUID() })),
    save([{ path: 'one.ts', content: 'new one', revision: 1 }, { path: 'two.ts', content: 'new two', revision: 1 }])])
  const pair = (await readAll(a.id, project.id, racing)).filter(r => r.kind === 'source' && ['one.ts', 'two.ts'].includes(r.data.path)).map(r => r.data.content).join('|')
  assert(['old one|old two', 'new one|new two'].includes(pair))
  await ok(admin.from('projects').delete().eq('id', project.id).eq('user_id', a.id))
  assert.equal((await admin.rpc('read_project_archive', { p_user_id: a.id, p_project_id: project.id, p_archive_id: racing.id })).error?.message, 'ARCHIVE_NOT_FOUND')
  console.log('PASS: full archive snapshot, 1105 messages, immutable submission evidence, conflicts, credentials excluded, owner isolation, races, paging integrity and cleanup without original-data loss.')
} finally {
  for (const client of clients) await client.auth.signOut().catch(() => undefined)
  for (const id of users) if ((await admin.auth.admin.deleteUser(id)).error) throw new Error('Disposable archive account cleanup failed.')
  console.log('Removed disposable archive accounts; no VMs or AI requests were created.')
}
