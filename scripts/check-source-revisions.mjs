import assert from 'node:assert/strict'

/** Uses only the caller's disposable integration-test project; no paid VMs. */
export async function checkSourceRevisions({ admin, request, a, b, projectId }) {
  const endpoint = `/api/projects/${projectId}/files`
  const write = (files, account = a) => request(endpoint, account, 'PUT', { files })
  const args = (files, userId = a.id) => ({ p_user_id: userId, p_project_id: projectId, p_files: files, p_create_only: false })
  const base = { path: 'revisions/main.ts', content: 'base', revision: 0 }

  for (const client of [a.client, b.client]) {
    assert((await client.rpc('save_source_revision_batch', args([base]))).error, 'Source CAS RPC must be server-only')
    assert((await client.from('source_files').insert({ project_id: projectId, user_id: a.id, path: base.path, content: 'bypass' })).error, 'Direct source insert must be revoked')
    assert((await client.from('source_files').upsert({ project_id: projectId, user_id: a.id, path: base.path, content: 'bypass' }, { onConflict: 'project_id,path' })).error, 'Direct source upsert must be revoked')
  }
  assert.equal((await admin.rpc('save_source_revision_batch', args([base], b.id))).error?.message, 'PROJECT_NOT_FOUND')
  assert.equal((await write([base], b)).status, 404)
  const created = await write([base])
  assert.equal(created.status, 200)
  assert.deepEqual((await created.json()).receipts, [{ path: base.path, revision: 1 }])

  // Test the private database boundary directly as well as the API. Two
  // individually valid source paths must not create an unrestorable snapshot.
  for (const paths of [['namespace-batch', 'namespace-batch/file.ts'], ['namespace-reverse/file.ts', 'namespace-reverse']]) {
    const result = await admin.rpc('save_source_revision_batch', args(paths.map((path) => ({ path, content: 'temporary', revision: 0 }))))
    assert.equal(result.error?.message, 'SOURCE_PATH_CONFLICT', 'A file cannot also be a source directory')
    assert.deepEqual((await a.client.from('source_files').select('path').eq('project_id', projectId).in('path', paths)).data, [], 'Namespace collisions must roll back the entire batch')
  }
  const namespaceRaces = await Promise.all(['namespace-race', 'namespace-race/file.ts'].map((path) =>
    admin.rpc('save_source_revision_batch', args([{ path, content: 'temporary', revision: 0 }]))))
  assert.equal(namespaceRaces.filter((result) => !result.error).length, 1, 'Concurrent file/directory creation must have exactly one winner')
  assert.equal(namespaceRaces.find((result) => result.error)?.error.message, 'SOURCE_PATH_CONFLICT')
  assert.equal((await write([{ path: 'namespace-parent', content: 'parent' }])).status, 200)
  const pathConflict = await write([{ path: 'namespace-parent/child.ts', content: 'must not save' }])
  assert.equal(pathConflict.status, 409)
  assert.equal((await pathConflict.json()).error.code, 'SOURCE_PATH_CONFLICT')
  assert.equal((await write([{ path: 'namespace-children/file.ts', content: 'child' }])).status, 200)
  assert.equal((await write([{ path: 'namespace-children', content: 'must not save' }])).status, 409)
  assert.equal((await write(['near', 'near-other/file.ts', '%_', '%_other/file.ts', 'Case', 'case/file.ts', '__proto__/file.ts', 'constructor/file.ts'].map((path) => ({ path, content: 'temporary' })))).status, 200, 'Prefix matching must respect separators, case and literal SQL wildcard characters')

  const candidates = ['writer a', 'writer b'].map((content) => ({ ...base, content, revision: 1 }))
  const races = await Promise.all(candidates.map((file) => write([file])))
  assert.deepEqual(races.map((response) => response.status).sort(), [200, 409], 'Exactly one stale concurrent writer may succeed')
  const winner = candidates[races.findIndex((response) => response.status === 200)]
  const conflict = await races.find((response) => response.status === 409).json()
  assert.equal(conflict.error.code, 'SOURCE_CONFLICT')
  assert.equal(typeof conflict.error.requestId, 'string')
  const read = async () => {
    const result = await a.client.from('source_files').select('path,content,revision').eq('project_id', projectId).eq('path', base.path).single()
    assert.equal(result.error, null)
    return result.data
  }
  assert.deepEqual(await read(), { ...winner, revision: 2 })
  const retried = await write([winner])
  assert.equal(retried.status, 200)
  assert.deepEqual((await retried.json()).receipts, [{ path: base.path, revision: 2 }], 'Lost-receipt retry must not increment the revision')
  assert.equal((await write([{ path: base.path, content: 'legacy stale overwrite' }])).status, 409)
  assert.equal((await write([{ ...base, content: 'future revision', revision: 500 }])).status, 409)

  const batch = await write([{ path: 'revisions/rollback.ts', content: 'must not exist', revision: 0 }, { ...base, content: 'stale', revision: 1 }])
  assert.equal(batch.status, 409)
  assert.deepEqual((await a.client.from('source_files').select('path').eq('project_id', projectId).eq('path', 'revisions/rollback.ts')).data, [], 'Conflicting batches must roll back every file')
  assert.deepEqual(await read(), { ...winner, revision: 2 })
  assert.equal((await admin.rpc('save_source_revision_batch', { ...args([winner]), p_create_only: true })).error?.message, 'FILE_ALREADY_EXISTS')

  for (const revision of [-1, 1.5, 2_147_483_648, '1']) {
    assert.equal((await write([{ ...base, revision }])).status, 400)
  }
  for (const path of ['../escape', 'src/../../escape', 'src\\escape', '/absolute', './relative', 'src//file']) {
    assert.equal((await admin.rpc('save_source_revision_batch', args([{ path, content: 'blocked', revision: 0 }]))).error?.code, '23514')
  }
  assert((await a.client.from('source_files').update({ content: 'bypass' }).eq('project_id', projectId)).error, 'Direct source update must be revoked')
  assert((await a.client.from('source_files').delete().eq('project_id', projectId)).error, 'Direct source delete must be revoked')
  assert.deepEqual(await read(), { ...winner, revision: 2 })
  assert.deepEqual((await b.client.from('source_files').select('path').eq('project_id', projectId)).data, [], 'Cross-user source reads must remain isolated')
  console.log('PASS: real source revision/namespace races, idempotent retry, atomic batch rollback, validation, private RPC/table write permissions, and two-user isolation.')
}
