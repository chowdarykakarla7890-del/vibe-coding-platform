import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export async function checkActivitySubmissions({ admin, request, a, b }) {
  async function ok(promise) { const result = await promise; assert.equal(result.error, null); return result.data }
  const manifest = { id: `generated-${randomUUID()}`, title: 'Submission history fixture', summary: 'An owned activity for testing immutable source history.',
    mode: 'practice', language: 'JavaScript', difficulty: 'beginner', concepts: ['functions'], estimatedMinutes: 10,
    instructions: ['Implement the function.'], starterFiles: [{ path: 'main.js', content: '// TODO' }], verify: { kind: 'rubric' },
    rubric: [{ id: 'correctness', label: 'Correctness', weight: 100 }], source: 'generated' }
  const project = await ok(admin.from('projects').insert({ user_id: a.id, title: 'Disposable submission history', activity_id: manifest.id, language: manifest.language }).select('id').single())
  await ok(admin.from('generated_activities').insert({ user_id: a.id, id: manifest.id, manifest }))
  await ok(admin.rpc('save_source_revision_batch', { p_user_id: a.id, p_project_id: project.id,
    p_files: [{ path: 'main.js', content: 'submitted original 😀', revision: 0 }, { path: 'helper.js', content: 'helper', revision: 0 }] }))
  const begin = () => admin.rpc('begin_activity_submission', { p_user_id: a.id, p_project_id: project.id, p_submission_id: randomUUID(),
    p_manifest: manifest, p_language: manifest.language, p_model_id: 'openai/gpt-5-nano' })
  const submission = await ok(begin())
  await ok(admin.rpc('record_submission_assessment', { p_user_id: a.id, p_submission_id: submission.id, p_score: 85,
    p_passed: true, p_ai_assessed: true, p_feedback: ['Synthetic history assessment'], p_verification_kind: 'rubric' }))
  // A deadline can race an already-committed assessment. Cleanup must never
  // erase that score, and an unprivileged or different user cannot close it.
  assert((await a.client.rpc('fail_activity_submission', { p_user_id: a.id, p_submission_id: submission.id, p_code: 'SUBMISSION_INTERRUPTED' })).error)
  assert.equal(await ok(admin.rpc('fail_activity_submission', { p_user_id: b.id, p_submission_id: submission.id, p_code: 'SUBMISSION_INTERRUPTED' })), false)
  assert.equal(await ok(admin.rpc('fail_activity_submission', { p_user_id: a.id, p_submission_id: submission.id, p_code: 'SUBMISSION_INTERRUPTED' })), false)
  const endpoint = `/api/projects/${project.id}/submissions`
  assert.equal((await request(endpoint)).status, 401)
  assert.equal((await request(endpoint, b)).status, 404)
  assert.equal((await request(`${endpoint}?after=invalid`, a)).status, 400)
  const list = await request(endpoint, a)
  assert.equal(list.status, 200); assert.match(list.headers.get('cache-control'), /no-store/)
  assert.equal((await list.json()).submissions[0].score, 85)
  const detail = await request(`${endpoint}/${submission.id}`, a)
  assert.equal(detail.status, 200)
  const body = await detail.json()
  assert.equal(body.title, manifest.title); assert.equal(body.files.length, 2)
  const index = body.files.findIndex((file) => file.path === 'main.js')
  const filePath = `${endpoint}/${submission.id}?file=${index}`
  await ok(admin.rpc('save_source_revision_batch', { p_user_id: a.id, p_project_id: project.id,
    p_files: [{ path: 'main.js', content: 'newer unsent copy', revision: 1 }] }))
  const file = await request(filePath, a)
  assert.equal(file.status, 200)
  assert.deepEqual(await file.json(), { path: 'main.js', content: 'submitted original 😀', revision: 1 })
  assert.equal((await request(filePath, b)).status, 404)
  assert.equal((await request(filePath)).status, 401)
  assert.equal((await request(`${endpoint}/${submission.id}?file=999`, a)).status, 400)
  assert.equal((await request(`${endpoint}/${submission.id}?file=-1`, a)).status, 400)
  assert.equal((await request(`${endpoint}/${submission.id}?file=0->secret`, a)).status, 400)
  assert.equal((await request(`${endpoint}/invalid`, a)).status, 400)
  assert.equal((await request(`${endpoint}/${randomUUID()}`, a)).status, 404)

  const pending = await ok(begin())
  assert.equal(await ok(admin.rpc('fail_activity_submission', { p_user_id: a.id, p_submission_id: pending.id, p_code: 'SUBMISSION_INTERRUPTED' })), true)
  const lateScore = await admin.rpc('record_submission_assessment', { p_user_id: a.id, p_submission_id: pending.id, p_score: 100,
    p_passed: true, p_ai_assessed: true, p_feedback: ['Late synthetic assessment'], p_verification_kind: 'rubric' })
  assert.equal(lateScore.error?.message, 'SUBMISSION_CLOSED')
  assert.equal((await ok(admin.from('assessments').select('id').eq('submission_id', pending.id))).length, 0)
  // Same-timestamp fixtures exercise the ID tie-breaker and interrupted display.
  const copyableSubmission = { ...pending }
  delete copyableSubmission.metadata_bytes
  const copies = Array.from({ length: 22 }, () => ({ ...copyableSubmission, id: randomUUID(), created_at: '2026-01-01T00:00:00Z', expires_at: '2026-01-01T00:05:00Z' }))
  await ok(admin.from('activity_submissions').insert(copies))
  const firstPage = await (await request(endpoint, a)).json()
  assert.equal(firstPage.submissions.length, 20); assert(firstPage.nextCursor)
  assert(firstPage.submissions.some((item) => item.state === 'interrupted'))
  const secondPage = await (await request(`${endpoint}?after=${firstPage.nextCursor}`, a)).json()
  assert.equal(secondPage.submissions.length, 4); assert.equal(secondPage.nextCursor, null)
  assert.equal(new Set([...firstPage.submissions, ...secondPage.submissions].map((item) => item.id)).size, 24)

  // Exercise a real verification request without invoking a paid provider: all
  // source is snapshotted, then the assessor's input budget rejects it safely.
  const sandboxId = `submission-test-${randomUUID()}`
  await ok(admin.from('sandbox_sessions').insert({ user_id: a.id, project_id: project.id, sandbox_id: sandboxId,
    status: 'expired', expires_at: new Date(Date.now() - 1000).toISOString() }))
  await ok(admin.rpc('save_source_revision_batch', { p_user_id: a.id, p_project_id: project.id,
    p_files: [{ path: 'main.js', content: 'x'.repeat(65000), revision: 2 }] }))
  const assessment = await request('/api/activities/verify', a, 'POST', { projectId: project.id, activityId: manifest.id, sandboxId, modelId: 'openai/gpt-5-nano' })
  assert.equal(assessment.status, 413)
  const failed = await assessment.json()
  assert.equal(failed.error.code, 'SUBMISSION_EVIDENCE_TOO_LARGE')
  const retained = await (await request(`${endpoint}/${failed.error.requestId}`, a)).json()
  assert.equal(retained.state, 'failed'); assert.equal(retained.score, null)
  assert.equal(retained.failureCode, 'SUBMISSION_EVIDENCE_TOO_LARGE')
  assert.equal((await ok(admin.from('assessments').select('id').eq('submission_id', failed.error.requestId))).length, 0)
  assert.equal((await request('/api/activities/verify', b, 'POST', { projectId: project.id, activityId: manifest.id, sandboxId })).status, 404)
  await ok(admin.from('projects').delete().eq('id', project.id).eq('user_id', a.id))
  await ok(admin.from('generated_activities').delete().eq('id', manifest.id).eq('user_id', a.id))
  assert.equal((await request(endpoint, a)).status, 404)
  console.log('PASS: hosted submission API ownership, immutable files, bounded reads, pagination, interrupted history, completion/cleanup races, expired-VM independence and failed evidence retention.')
}
