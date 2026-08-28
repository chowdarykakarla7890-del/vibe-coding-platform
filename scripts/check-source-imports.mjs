import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'

const hash = value => createHash('sha256').update(value).digest('hex')
export async function checkSourceImports({ admin, request, a, b }) {
  const id = randomUUID(), path = `/api/projects/imports/${id}`
  const file = { path: 'main.ts', content: 'export source 😀' }
  const digest = hash(file.content)
  const header = { id, title: 'Disposable source import HTTP check', language: 'TypeScript', fileCount: 1,
    sourceBytes: Buffer.byteLength(file.content), digest: hash(`${file.path}:${digest}\n`) }
  const upload = { files: [{ ...file, digest }] }
  try {
    assert.equal((await request('/api/projects/imports', undefined, 'POST', header)).status, 401)
    assert.equal((await request('/api/projects/imports', a, 'POST', header, 'https://other.invalid')).status, 403)
    assert.equal((await request('/api/projects/imports', a, 'POST', '{')).status, 400)
    for (const forged of [{ userId: b.id }, { messages: [] }, { sandboxId: 'forged' }, { score: 100 }, { activityId: 'forged' }]) {
      assert.equal((await request('/api/projects/imports', a, 'POST', { ...header, ...forged })).status, 400)
    }
    const begin = await request('/api/projects/imports', a, 'POST', header)
    assert.equal(begin.status, 201); assert.equal(begin.headers.get('cache-control'), 'private, no-store')
    const before = await admin.from('projects').select('id').eq('id', id)
    assert.equal(before.error, null); assert.equal(before.data.length, 0)
    for (const method of ['GET', 'PUT', 'POST', 'DELETE']) {
      assert.equal((await request(path, b, method, method === 'PUT' ? upload : method === 'POST' ? {} : undefined)).status, 404)
    }
    const privateRPC = await a.client.rpc('source_import_operation', { p_user_id: a.id, p_import_id: id, p_action: 'read' })
    assert(privateRPC.error, 'Authenticated browser roles must not invoke import RPCs')
    assert.equal((await request(path, a, 'POST', {})).status, 409)
    assert.equal((await request(path, a, 'PUT', { files: [{ ...file, digest: '0'.repeat(64) }] })).status, 400)
    assert.equal((await request(path, a, 'PUT', { files: [{ ...file, path: '../escape', digest }] })).status, 400)
    assert.equal((await request(path, a, 'PUT', upload)).status, 200)
    assert.equal((await request(path, a, 'PUT', upload)).status, 200)
    const results = await Promise.all([request(path, a, 'POST', {}), request(path, a, 'POST', {})])
    for (const result of results) {
      assert.equal(result.status, 200)
      const value = await result.json()
      assert.equal(value.state, 'published'); assert.equal(value.project.id, id)
      assert.equal(value.project.mode, 'playground'); assert.equal(value.project.status, 'active')
      assert.equal(value.project.activity_id, null)
    }
    const source = await admin.from('source_files').select('content,revision').eq('project_id', id).eq('user_id', a.id).single()
    assert.equal(source.error, null); assert.equal(source.data.content, file.content); assert.equal(source.data.revision, 1)
    assert.equal((await b.client.from('source_files').select('path').eq('project_id', id)).data.length, 0)
    assert.equal((await request(`/api/projects/${id}/files`, a, 'PUT', { files: [{ path: file.path, content: 'newer saved work', revision: 1 }] })).status, 200)
    const cancel = await request(path, a, 'DELETE')
    assert.equal(cancel.status, 200); assert.equal((await cancel.json()).state, 'published')
    assert.equal((await request(path, a, 'POST', {})).status, 200)
    const newer = await admin.from('source_files').select('content,revision').eq('project_id', id).single()
    assert.equal(newer.error, null); assert.equal(newer.data.content, 'newer saved work'); assert.equal(newer.data.revision, 2)
    for (let i = 0; i < 9; i++) assert.equal((await request('/api/projects/imports', a, 'POST', header)).status, 201)
    const limited = await request('/api/projects/imports', a, 'POST', header)
    assert.equal(limited.status, 429); assert(limited.headers.get('retry-after'))
    assert.equal((await request(`/api/projects/${id}`, a, 'DELETE')).status, 200)
    assert.equal((await request(path, a, 'POST', {})).status, 410)
    console.log('PASS: authenticated source import, malformed input, CSRF, cross-user isolation, atomic publication, concurrent retries, unchanged newer edits, cancellation and quotas.')
  } finally {
    const cleanup = await admin.from('projects').delete().eq('id', id).eq('user_id', a.id)
    assert.equal(cleanup.error, null)
  }
}
