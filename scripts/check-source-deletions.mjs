import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

/** Disposable integration fixtures only. Does not create or contact a VM. */
export async function checkSourceDeletions({ admin, request, a, b, projectId, sandboxId }) {
  const rpc = (files, createOnly = false, userId = a.id, id = projectId) => admin.rpc('save_source_revision_batch', {
    p_user_id: userId, p_project_id: id, p_files: files, p_create_only: createOnly,
  })
  const save = async (files, createOnly = false, id = projectId) => {
    const result = await rpc(files, createOnly, a.id, id)
    assert.equal(result.error, null)
    return result.data
  }
  const path = '000-deletion.ts'
  const original = { path, content: 'original', revision: 0 }
  assert.deepEqual(await save([original]), [{ path, revision: 1 }])
  const deletion = { path, content: '', revision: 1, deleted: true }
  assert.deepEqual(await save([deletion]), [{ path, revision: 2 }])
  const read = () => a.client.from('source_files').select('content,deleted,revision,updated_at').eq('project_id', projectId).eq('path', path).single()
  const tombstone = await read()
  assert.equal(tombstone.error, null)
  assert.equal(tombstone.data.deleted, true, 'Deletion must leave a revision fence, not an empty live file')
  assert.equal(tombstone.data.content, '')
  assert.deepEqual(await save([deletion]), [{ path, revision: 2 }])
  assert.deepEqual((await read()).data, tombstone.data, 'Deletion retries must not update the revision or timestamp')
  for (const file of [original, { ...original, revision: 1 }, { path, content: '', revision: 0 }]) {
    assert.equal((await rpc([file])).error?.message, 'SOURCE_CONFLICT', 'Stale writes cannot resurrect deleted paths')
  }
  const listing = await (await request(`/api/projects/${projectId}/files`, a)).json()
  assert(!listing.files.some((file) => file.path === path), 'Exports/restores must exclude tombstones')
  const source = await request(`/api/sandboxes/${sandboxId}/files?path=${path}`, a)
  assert.equal(source.status, 404)
  assert.equal(source.headers.get('x-source-revision'), '2')
  assert.equal((await source.json()).error.code, 'FILE_DELETED')
  assert.equal((await request(`/api/sandboxes/${sandboxId}/files?path=${path}`, b)).status, 404)
  assert.equal((await rpc([{ path, content: '', deleted: true, revision: 2 }], false, b.id)).error?.message, 'PROJECT_NOT_FOUND')
  assert.deepEqual((await b.client.from('source_files').select('path').eq('project_id', projectId).eq('path', path)).data, [])

  assert.deepEqual(await save([{ path, content: 'recreated', revision: 2 }], true), [{ path, revision: 3 }])
  assert.equal((await rpc([{ ...deletion, revision: 2 }])).error?.message, 'SOURCE_CONFLICT', 'Old deletions cannot delete a recreated file')
  assert.equal((await rpc([{ path, content: 'recreated', revision: 999 }])).error?.message, 'SOURCE_CONFLICT', 'Future revisions cannot be accepted as retries')
  assert.equal((await rpc([{ path, content: 'recreated', revision: 3 }], true)).error?.message, 'FILE_ALREADY_EXISTS')
  assert.equal((await rpc([{ ...deletion, revision: 3, content: 'must not retain deleted contents' }])).error?.message, 'INVALID_SOURCE')
  assert.equal((await rpc([{ path, content: '', revision: 3, deleted: null }])).error?.message, 'INVALID_SOURCE')
  assert.equal((await rpc([{ path, content: '', revision: 3, deleted: true }], true)).error?.message, 'INVALID_SOURCE')

  // Both namespace directions, with inserts intentionally listed first.
  await save([{ path: 'deletion-swap', content: 'parent' }])
  assert.deepEqual(await save([{ path: 'deletion-swap/child.ts', content: 'child' }, { path: 'deletion-swap', content: '', deleted: true, revision: 1 }]),
    [{ path: 'deletion-swap/child.ts', revision: 1 }, { path: 'deletion-swap', revision: 2 }])
  await save([{ path: 'deletion-swap', content: 'parent restored', revision: 2 }, { path: 'deletion-swap/child.ts', content: '', deleted: true, revision: 1 }])
  const before = (await read()).data
  assert.equal((await rpc([{ path, content: '', deleted: true, revision: 3 }, { path: 'deletion-swap', content: 'stale', revision: 1 }])).error?.message, 'SOURCE_CONFLICT')
  assert.deepEqual((await read()).data, before, 'A rejected batch must not partly delete source')

  const race = await Promise.all([
    rpc([{ path, content: '', deleted: true, revision: 3 }]),
    rpc([{ path, content: 'concurrent edit', revision: 3 }]),
  ])
  assert.equal(race.filter((item) => !item.error).length, 1)
  assert.equal(race.find((item) => item.error).error.message, 'SOURCE_CONFLICT')
  assert.equal((await read()).data.revision, 4)

  // A full 200-file replacement must fit even though old tombstones remain.
  const quotaId = randomUUID()
  assert.equal((await admin.from('projects').insert({ id: quotaId, user_id: a.id, title: 'Temporary deletion quota test' })).error, null)
  try {
    const files = Array.from({ length: 200 }, (_, index) => ({ path: `old-${index}.ts`, content: '' }))
    await save(files, false, quotaId)
    const replacement = [...files.map((file) => ({ path: file.path.replace('old-', 'new-'), content: '' })),
      ...files.map((file) => ({ ...file, revision: 1, deleted: true }))]
    const receipts = await save(replacement, false, quotaId)
    assert.equal(receipts.length, 400)
    assert.equal((await a.client.from('source_files').select('path', { count: 'exact', head: true }).eq('project_id', quotaId).eq('deleted', false)).count, 200)
    assert.equal((await rpc([{ path: 'overflow.ts', content: '' }], false, a.id, quotaId)).error?.code, '23514')
  } finally {
    assert.equal((await admin.from('projects').delete().eq('id', quotaId).eq('user_id', a.id)).error, null)
  }
  console.log('PASS: deletion fences, idempotent retries, stale resurrection/deletion denial, namespace swaps, atomic rollback, full-capacity replacement, and cross-user isolation.')
}
