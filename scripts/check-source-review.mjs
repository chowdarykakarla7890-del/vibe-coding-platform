// Real authenticated HTTP routes + hosted DB. Synthetic source only; no VM/AI.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'

export async function checkSourceReview({ admin, request, a, b }) {
  const ok = async (promise) => { const result = await promise; assert.equal(result.error, null); return result.data }
  const json = async (response, status = 200) => { assert.equal(response.status, status); return response.json() }
  const hash = (value) => createHash('sha256').update(value).digest('hex')
  const { project } = await json(await request('/api/projects', a, 'POST', { title: 'Disposable source review' }), 201)
  try {
    const save = (content, revision) => ok(admin.rpc('save_source_revision_batch', { p_user_id: a.id, p_project_id: project.id,
      p_files: [{ path: 'main.ts', content, revision }] }))
    await save('original', 0)
    const session = await ok(admin.from('sandbox_sessions').insert({ user_id: a.id, project_id: project.id, sandbox_id: `test-only-${randomUUID()}`,
      status: 'running', expires_at: new Date(Date.now() + 60000).toISOString() }).select('id').single())
    const command = await ok(admin.rpc('reserve_command_execution', { p_user_id: a.id, p_session_id: session.id,
      p_request_id: randomUUID(), p_executable: 'node', p_origin: 'terminal', p_background: false }))
    await ok(admin.rpc('finish_command_execution', { p_user_id: a.id, p_reservation_id: command.id, p_status: 'done', p_exit_code: 0 }))
    await save('saved editor', 1)
    const job = await ok(admin.rpc('claim_source_capture', { p_job_id: command.id }))
    const entries = [{ path: 'main.ts', kind: 'file', content: 'terminal', digest: hash('terminal'), baseRevision: 1, baseDigest: hash('original'), pending: false },
      ...Array.from({ length: 20 }, (_, i) => ({ path: `file${i}.ts`, kind: 'file', content: 'source', digest: hash('source'), baseRevision: 0, baseDigest: null, pending: false }))]
    await ok(admin.rpc('reconcile_source_capture', { p_job_id: job.id, p_lease_token: job.lease_token, p_terminal: true,
      p_capture: { entries, complete: true, totalBytes: entries.reduce((sum, item) => sum + Buffer.byteLength(item.content), 0), excluded: 0 } }))
    await ok(admin.rpc('settle_source_capture', { p_job_id: job.id, p_lease_token: job.lease_token, p_action: 'acknowledged' }))
    const base = `/api/projects/${project.id}/source-recovery`
    assert.equal((await request(base)).status, 401)
    assert.equal((await request(base, b)).status, 404)
    assert.equal((await request(`${base}?after=bad`, a)).status, 400)
    assert.equal((await request(`${base}?history=false`, a)).status, 400)
    const firstResponse = await request(base, a)
    assert.equal(firstResponse.headers.get('cache-control'), 'private, no-store')
    assert(firstResponse.headers.get('x-request-id')); assert(firstResponse.headers.get('x-ratelimit-limit'))
    const first = await json(firstResponse)
    assert.equal(first.unresolved, 21); assert.equal(first.conflicts.length, 20)
    assert(first.conflicts.every((item) => !('captured_content' in item) && !('captured' in item)))
    const next = await json(await request(`${base}?after=${first.nextCursor}`, a))
    assert.equal(next.conflicts.length, 1); assert.equal(next.nextCursor, null)
    const reviews = [...first.conflicts, ...next.conflicts]
    assert.equal(new Set(reviews.map((item) => item.id)).size, 21)
    const review = reviews.find((item) => item.path === 'main.ts'), path = `${base}/${review.id}`
    assert.equal((await request(path)).status, 401)
    assert.equal((await request(path, b)).status, 404)
    assert.equal((await request(`${base}/bad`, a)).status, 400)
    assert.equal((await request(`${base}/${randomUUID()}`, a)).status, 404)
    const detail = await json(await request(path, a))
    assert.deepEqual(detail.current, { content: 'saved editor', revision: 2 })
    assert.equal(detail.conflict.captured, 'terminal'); assert.equal(detail.resolution, null)
    for (const body of ['{', { choice: 'other', revision: 2 }, { choice: 'saved', revision: -1 },
      { choice: 'saved', revision: 2, userId: b.id }, { choice: 'merged', revision: 2, content: '\0' },
      { choice: 'merged', revision: 2, content: 'x'.repeat(262145) }]) {
      const error = await json(await request(path, a, 'POST', body), 400)
      assert(error.error.code); assert(error.error.requestId)
    }
    assert.equal((await request(path, b, 'POST', { choice: 'captured', revision: 2 })).status, 404)
    assert.equal((await request(path, a, 'POST', { choice: 'captured', revision: 2 }, 'https://wrong.example')).status, 403)
    await save('newer editor', 2)
    const stale = await json(await request(path, a, 'POST', { choice: 'captured', revision: 2 }), 409)
    assert.equal(stale.error.code, 'SOURCE_CONFLICT')
    const refreshed = await json(await request(path, a))
    assert.equal(refreshed.current.revision, 3)
    const input = { choice: 'merged', revision: 3, content: 'reviewed merge' }
    const receipt = await json(await request(path, a, 'POST', input))
    assert.equal(receipt.revision, 4); assert.equal(receipt.choice, 'merged')
    assert.deepEqual(await json(await request(path, a, 'POST', input)), receipt)
    const resolved = await json(await request(path, a))
    assert.equal(resolved.current.content, 'newer editor'); assert.equal(resolved.resolution.revision, 4)
    assert.equal((await json(await request(`${base}?history=1`, a))).conflicts[0].id, review.id)
    assert.equal((await json(await request(base, a))).unresolved, 20)
    assert.equal((await json(await request(base, a))).savedOnly, 1)
    assert.equal((await json(await request(path, a, 'POST', { choice: 'saved', revision: 4 }), 409)).error.code, 'SOURCE_REVIEW_RESOLVED')
    // Retry only paused, owned capture jobs; it cannot accept a sandbox/user ID
    // from the browser or claim that a queued save has already completed.
    const retryJob = await ok(admin.from('command_audits').insert({ user_id: a.id, sandbox_session_id: session.id,
      request_id: randomUUID(), executable: 'node', status: 'done', exit_code: 0 }).select('id').single())
    await ok(admin.from('source_capture_jobs').update({ state: 'incomplete', retry_state: 'capturing', failures: 12, failure_code: 'capture_failed' }).eq('id', retryJob.id))
    assert.equal((await json(await request(base, a))).paused, 1)
    assert.equal((await request(base, undefined, 'POST', { action: 'retry' })).status, 401)
    assert.equal((await request(base, b, 'POST', { action: 'retry' })).status, 404)
    assert.equal((await request(base, a, 'POST', { action: 'retry' }, 'https://wrong.example')).status, 403)
    for (const body of ['{', {}, { action: 'other' }, { action: 'retry', userId: b.id }, { action: 'retry', sandboxId: 'forged' }]) {
      const invalid = await json(await request(base, a, 'POST', body), 400)
      assert(invalid.error.requestId); assert(invalid.error.code)
    }
    assert.equal((await request(base, a, 'POST', 'x'.repeat(1025))).status, 413)
    const retried = await request(base, a, 'POST', { action: 'retry' })
    assert.equal(retried.headers.get('x-ratelimit-limit'), '3')
    assert.equal(retried.headers.get('cache-control'), 'private, no-store')
    assert.deepEqual(await json(retried), { resumed: 1 })
    assert.deepEqual(await json(await request(base, a, 'POST', { action: 'retry' })), { resumed: 0 })
    const resumed = await ok(admin.from('source_capture_jobs').select('state,failures,retry_state').eq('id', retryJob.id).single())
    assert.deepEqual(resumed, { state: 'capturing', failures: 0, retry_state: null })
    // Resolution stores source without any VM lookup, even after expiry.
    await ok(admin.from('sandbox_sessions').update({ status: 'expired' }).eq('id', session.id))
    assert.equal((await json(await request(base, a, 'POST', { action: 'retry' }), 410)).error.code, 'SANDBOX_EXPIRED')
    const limited = await request(base, a, 'POST', { action: 'retry' })
    assert.equal(limited.status, 429); assert(limited.headers.get('retry-after'))
    const sibling = reviews.find((item) => item.path !== 'main.ts')
    assert.equal((await json(await request(`${base}/${sibling.id}`, a, 'POST', { choice: 'captured', revision: 0 }))).revision, 1)
    const source = await ok(admin.from('source_files').select('content').eq('project_id', project.id).eq('path', 'main.ts').single())
    assert.equal(source.content, 'reviewed merge')
    console.log('PASS: source-review HTTP auth/ownership, pagination, safe validation, CSRF, stale revisions, merge/retry, retained copies and expired-sandbox resolution.')
    console.log('PASS: capture-retry HTTP ownership, paused status, strict bodies, bounded receipts, request IDs, quotas and expired-VM refusal.')
  } finally { await ok(admin.from('projects').delete().eq('id', project.id).eq('user_id', a.id)) }
}
