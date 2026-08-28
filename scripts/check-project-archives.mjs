import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'

export async function checkProjectArchives({ admin, request, a, b }) {
  const created = await admin.from('projects').insert({ user_id: a.id, title: 'Disposable archive HTTP check' }).select('id').single()
  assert.equal(created.error, null)
  const projectId = created.data.id
  const path = `/api/projects/${projectId}/archives`, archiveId = randomUUID()
  try {
    const saved = await admin.rpc('save_source_revision_batch', { p_user_id: a.id, p_project_id: projectId,
      p_files: [{ path: 'main.ts', content: 'export const value = "😀"', revision: 0 }] })
    assert.equal(saved.error, null)
    assert.equal((await request(path, undefined, 'POST', { archiveId })).status, 401)
    assert.equal((await request(path, b, 'POST', { archiveId })).status, 404)
    assert.equal((await request(path, a, 'POST', { archiveId }, 'https://other.invalid')).status, 403)
    assert.equal((await request(path, a, 'POST', '{')).status, 400)
    assert.equal((await request(path, a, 'POST', { archiveId, userId: b.id })).status, 400)
    const response = await request(path, a, 'POST', { archiveId })
    assert.equal(response.status, 201)
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.equal(response.headers.get('x-ratelimit-limit'), '3')
    const receipt = await response.json()
    assert.equal(receipt.recordCount, 2)
    const pagePath = `${path}/${receipt.id}`
    assert.equal((await request(pagePath, b)).status, 404)
    assert.equal((await request(pagePath)).status, 401)
    assert.equal((await request(`${pagePath}?after=-1`, a)).status, 400)
    const page = await (await request(pagePath, a)).json()
    assert.equal(page.records.length, 2)
    assert.equal(page.nextCursor, null)
    for (const record of page.records) assert.equal(createHash('sha256').update(record.record).digest('hex'), record.sha256)
    assert.equal(JSON.parse(page.records[1].record).data.content, 'export const value = "😀"')
    assert.equal((await request(pagePath, b, 'DELETE')).status, 404)
    assert.equal((await request(pagePath, a, 'DELETE', undefined, 'https://other.invalid')).status, 403)
    // Repeated creation returns the same frozen snapshot, then quota rejection.
    for (let i = 0; i < 2; i++) assert.equal((await request(path, a, 'POST', { archiveId })).status, 201)
    const limited = await request(path, a, 'POST', { archiveId })
    assert.equal(limited.status, 429); assert(limited.headers.get('retry-after'))
    assert.equal((await request(pagePath, a, 'DELETE')).status, 200)
    assert.equal((await request(pagePath, a)).status, 404)
    const original = await admin.from('source_files').select('content').eq('project_id', projectId).eq('user_id', a.id).single()
    assert.equal(original.data.content, 'export const value = "😀"')
    console.log('PASS: cookie-authenticated archive routes, owner isolation, malformed input, CSRF, hashes, quotas and temporary-only deletion.')
  } finally { assert.equal((await admin.from('projects').delete().eq('id', projectId).eq('user_id', a.id)).error, null) }
}
