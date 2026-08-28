import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

// Called with the temporary accounts owned by verify-auth-projects.mjs. Its
// finally cleanup removes these records even if an assertion below fails.
export async function checkLearningHistory({ admin, request, a, b }) {
  const prefix = `generated-smoke-${randomUUID()}`
  const manifests = Array.from({ length: 21 }, (_, index) => ({
    id: `${prefix}-${String(index).padStart(2, '0')}`, source: 'generated', mode: 'practice',
    title: 'Temporary learning check', summary: 'A generated activity used only for hosted isolation checks.',
    language: 'JavaScript', difficulty: 'beginner', concepts: ['functions'], estimatedMinutes: 10,
    instructions: ['Implement the example function.'],
    starterFiles: [{ path: 'main.js', content: 'export const example = () => 1' }],
    verify: { kind: 'rubric' }, rubric: [{ id: 'correctness', label: 'Correctness', weight: 100 }],
  }))
  const activity = manifests[0]
  const insert = await admin.from('generated_activities').insert(manifests.map((manifest) => ({ id: manifest.id, user_id: a.id, manifest })))
  assert.equal(insert.error, null)
  assert((await a.client.from('generated_activities').insert({ id: `${prefix}-forged`, user_id: a.id, manifest: activity })).error, 'Browser-created assessment manifests must be rejected')
  assert((await a.client.from('generated_activities').update({ manifest: { ...activity, title: 'Forged rubric' } }).eq('id', activity.id)).error)
  assert.equal((await b.client.from('generated_activities').select('id').eq('user_id', a.id)).data.length, 0)
  assert.equal((await request('/api/activities')).status, 401)
  assert.equal((await request('/api/progress')).status, 401)
  const first = await (await request('/api/activities', a)).json()
  assert.equal(first.activities.length, 20)
  assert.equal(first.nextCursor, manifests[19].id)
  const second = await (await request(`/api/activities?after=${first.nextCursor}`, a)).json()
  assert.deepEqual(second.activities.map((item) => item.id), [manifests[20].id])
  assert.equal(second.nextCursor, null)
  assert.deepEqual((await (await request('/api/activities', b)).json()).activities, [])
  assert.deepEqual((await (await request(`/api/activities/${activity.id}`, a)).json()).activity, activity)
  assert.equal((await (await request(`/api/activities/${activity.id}`, b)).json()).activity, null)

  // All cases are rejected before BotID, quota consumption or paid generation.
  const generation = { mode: 'practice', goal: 'Understand counting loops', language: 'TypeScript', difficulty: 'beginner' }
  for (const [owner, input, status] of [
    [undefined, generation, 401],
    [a, '{', 400],
    [a, { ...generation, goal: '     ' }, 400],
    [a, { ...generation, goal: 'x'.repeat(801) }, 400],
    [a, { ...generation, language: ' ' }, 400],
    [a, { ...generation, modelId: 'unsupported/model' }, 400],
    [a, { ...generation, userId: b.id }, 400],
  ]) {
    const rejected = await request('/api/activities/generate', owner, 'POST', input)
    assert.equal(rejected.status, status)
    const payload = await rejected.json()
    assert.equal(payload.error.requestId, rejected.headers.get('x-request-id'))
  }
  assert.equal((await request('/api/activities/generate', a, 'POST', generation, 'https://invalid.example')).status, 403)
  console.log('PASS: real authenticated custom-generation input/origin boundaries; no paid generation dispatched.')

  async function createActivityProject(owner) {
    const response = await request('/api/projects', owner, 'POST', { title: 'Temporary assessment check', mode: 'practice', activityId: activity.id, language: activity.language })
    assert.equal(response.status, 201)
    return (await response.json()).project
  }
  const projectA = await createActivityProject(a)
  const projectB = await createActivityProject(b)
  const parameters = {
    p_user_id: a.id, p_project_id: projectA.id, p_assessment_id: randomUUID(), p_activity_id: activity.id,
    p_score: 40, p_passed: false, p_ai_assessed: true, p_feedback: ['Temporary assessment feedback.'],
    p_concepts: ['not-yet-mastered'], p_model_id: 'openai/gpt-5-nano', p_verification_kind: 'rubric', p_language: 'JavaScript',
  }
  assert((await a.client.rpc('record_assessment', parameters)).error, 'Browsers must not call the server assessment function')
  assert.equal((await admin.rpc('record_assessment', { ...parameters, p_user_id: b.id })).error?.message, 'ACTIVITY_PROJECT_NOT_FOUND')
  assert.equal((await admin.rpc('record_assessment', { ...parameters, p_activity_id: 'wrong-activity' })).error?.message, 'ACTIVITY_PROJECT_NOT_FOUND')
  assert.equal((await admin.rpc('record_assessment', { ...parameters, p_passed: true })).error?.message, 'INVALID_ASSESSMENT')
  assert.equal((await admin.rpc('record_assessment', parameters)).error, null)
  assert.equal((await (await request(`/api/projects/${projectA.id}`, a)).json()).project.status, 'active')
  const passed = { ...parameters, p_assessment_id: randomUUID(), p_score: 85, p_passed: true, p_concepts: ['functions', 'state', 'functions'] }
  const recorded = await admin.rpc('record_assessment', passed)
  assert.equal(recorded.error, null)
  assert.equal(recorded.data, passed.p_assessment_id)
  assert.equal((await admin.rpc('record_assessment', passed)).data, passed.p_assessment_id, 'An identical retry must not add another attempt')
  assert.equal((await (await request(`/api/projects/${projectA.id}`, a)).json()).project.status, 'completed')
  const otherUserResult = { ...parameters, p_user_id: b.id, p_project_id: projectB.id, p_assessment_id: randomUUID(), p_score: 95, p_passed: true, p_concepts: ['private-concept'] }
  assert.equal((await admin.rpc('record_assessment', otherUserResult)).error, null)
  assert.equal((await admin.rpc('record_assessment', { ...otherUserResult, p_assessment_id: passed.p_assessment_id })).error?.message, 'ASSESSMENT_CONFLICT')
  assert((await a.client.from('assessments').insert({ id: randomUUID(), user_id: a.id, project_id: projectA.id, activity_id: activity.id, score: 100, passed: true, ai_assessed: false, feedback: [], concepts: [] })).error)
  assert((await a.client.from('assessments').update({ score: 100 }).eq('id', parameters.p_assessment_id)).error)
  assert.equal((await b.client.from('assessments').select('id').eq('project_id', projectA.id)).data.length, 0)
  const progressA = await (await request('/api/progress', a)).json()
  assert.equal(progressA.progress.length, 1)
  assert.equal(progressA.nextCursor, null)
  assert.deepEqual({ ...progressA.progress[0], updatedAt: 0 }, { activityId: activity.id, attempts: 2, bestScore: 85, completed: true, concepts: ['functions', 'state'], updatedAt: 0 })
  assert(Number.isFinite(progressA.progress[0].updatedAt))
  const progressB = await (await request('/api/progress', b)).json()
  assert.equal(progressB.progress[0].bestScore, 95)
  assert.deepEqual(progressB.progress[0].concepts, ['private-concept'])
  const directView = await a.client.from('assessment_progress').select('*')
  assert.equal(directView.error, null)
  assert.equal(directView.data.length, 1, 'The view must obey RLS even without an owner filter')
  assert.equal(directView.data[0].user_id, a.id)
  assert.equal((await a.client.from('assessment_progress').select('*').eq('user_id', b.id)).data.length, 0)

  // Invalid/forged verification requests must fail before any paid sandbox or
  // model call. No live VM ID is ever provided by this script.
  const input = { projectId: projectA.id, activityId: activity.id, sandboxId: 'sbx_smoke_nonexistent', modelId: 'openai/gpt-5-nano' }
  for (const [owner, body, status] of [
    [undefined, input, 401], [b, input, 404],
    [a, { ...input, modelId: 'unsupported/model' }, 400],
    [a, { ...input, generatedActivity: activity }, 400],
    [a, { ...input, activityId: 'wrong-activity' }, 409],
    [a, { ...input, language: 'forged-language' }, 400],
    [b, { ...input, projectId: projectB.id }, 404],
  ]) assert.equal((await request('/api/activities/verify', owner, 'POST', body)).status, status)
  assert.equal((await request('/api/progress?after=..', a)).status, 400)
  assert.equal((await request(`/api/projects/${projectA.id}`, a, 'DELETE')).status, 200)
  assert.equal((await admin.from('assessments').select('id').eq('project_id', projectA.id)).data.length, 0)
  assert.deepEqual((await (await request('/api/progress', a)).json()).progress, [])
  assert.equal((await (await request('/api/progress', b)).json()).progress[0].bestScore, 95)
  assert.equal((await request(`/api/projects/${projectB.id}`, b, 'DELETE')).status, 200)
  console.log('PASS: generated activity ownership/pagination, server-only scores, atomic completion, idempotent assessment recording, RLS-safe progress, verification input boundaries, and learning-history cascades.')
}
