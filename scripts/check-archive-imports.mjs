import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'

const hash = value => createHash('sha256').update(value).digest('hex')
const digestLine = (record, version) => version === 2 ? `${record.index}:${record.sha256}\n` :
  `${record.index}:${record.sha256}:${record.sectionId ?? ''}:${record.sectionIndex ?? 0}\n`
export async function checkArchiveImports({ admin, request, a, b }) {
  const id = randomUUID(), path = `/api/projects/archive-imports/${id}`, exportId = randomUUID()
  const recoveredIds = []
  let originalId
  try {
    const created = await request('/api/projects', a, 'POST', { title: 'Disposable archive round-trip', language: 'TypeScript' })
    assert.equal(created.status, 201)
    originalId = (await created.json()).project.id
    const content = 'export const recovered = "saved 😀"'
    assert.equal((await request(`/api/projects/${originalId}/files`, a, 'PUT', { files: [{ path: 'main.ts', content }] })).status, 200)
    const message = await admin.from('messages').insert({ project_id: originalId, user_id: a.id, id: randomUUID(), role: 'assistant', status: 'complete',
      model_id: 'openai/gpt-5-nano', parts: [{ type: 'text', text: 'Original saved chat' }, { type: 'tool-runCommand', state: 'output-available', output: 'never replay' }] })
    assert.equal(message.error, null)
    const exported = await request(`/api/projects/${originalId}/archives`, a, 'POST', { archiveId: exportId })
    assert.equal(exported.status, 201)
    const exportReceipt = await exported.json(), envelopes = []
    let cursor = 0
    do {
      const response = await request(`/api/projects/${originalId}/archives/${exportId}?after=${cursor}`, a)
      assert.equal(response.status, 200)
      const page = await response.json()
      for (const record of page.records) { assert.equal(hash(record.record), record.sha256); envelopes.push(record) }
      cursor = page.nextCursor
    } while (cursor !== null)
    assert.equal(envelopes.length, exportReceipt.recordCount)
    const { formatVersion = 2, ...exportManifest } = exportReceipt
    const manifest = { ...exportManifest, format: 'codetutor-project-archive', version: formatVersion, scope: 'saved-project', includesUnsavedDrafts: false, includesLiveSandboxFiles: false }
    const header = { id, manifest, digest: hash(envelopes.map(record => digestLine(record, manifest.version)).join('')) }
    assert.equal((await request('/api/projects/archive-imports', undefined, 'POST', header)).status, 401)
    assert.equal((await request('/api/projects/archive-imports', a, 'POST', header, 'https://other.invalid')).status, 403)
    assert.equal((await request('/api/projects/archive-imports', a, 'POST', '{')).status, 400)
    assert.equal((await request('/api/projects/archive-imports', a, 'POST', { ...header, userId: b.id })).status, 400)
    const begun = await request('/api/projects/archive-imports', a, 'POST', header)
    assert.equal(begun.status, 201); assert.equal(begun.headers.get('cache-control'), 'private, no-store')
    assert.equal((await begun.json()).state, 'uploading')
    assert.equal((await admin.from('projects').select('id').eq('id', id)).data.length, 0)
    for (const method of ['GET', 'PUT', 'POST', 'DELETE']) assert.equal((await request(path, b, method, method === 'PUT' ? { records: envelopes } : method === 'POST' ? {} : undefined)).status, 404)
    assert((await a.client.rpc('project_archive_import_operation', { p_user_id: a.id, p_import_id: id, p_action: 'read' })).error)
    assert((await a.client.rpc('read_imported_project_archive', { p_user_id: a.id, p_project_id: id })).error)
    assert.equal((await request(path, a, 'POST', {})).status, 409)
    assert.equal((await request(path, a, 'PUT', { records: [{ ...envelopes[0], sha256: '0'.repeat(64) }] })).status, 400)
    assert.equal((await request(path, a, 'PUT', { records: envelopes })).status, 200)
    assert.equal((await request(path, a, 'PUT', { records: envelopes })).status, 200)
    const commits = await Promise.all([request(path, a, 'POST', {}), request(path, a, 'POST', {})])
    for (const result of commits) {
      assert.equal(result.status, 200)
      const receipt = await result.json()
      assert.equal(receipt.state, 'published'); assert.equal(receipt.project.id, id)
      assert.equal(receipt.project.mode, 'playground'); assert.equal(receipt.project.activity_id, null)
    }
    const restored = await admin.from('source_files').select('content,revision').eq('project_id', id).single()
    assert.equal(restored.error, null); assert.equal(restored.data.content, content); assert.equal(restored.data.revision, 1)
    assert.equal((await admin.from('messages').select('id').eq('project_id', id)).data.length, 0)
    assert.equal((await admin.from('assessments').select('id').eq('project_id', id)).data.length, 0)
    assert.equal((await b.client.from('source_files').select('path').eq('project_id', id)).data.length, 0)
    assert.equal((await request(`/api/projects/${id}/imported-archive`, b)).status, 404)
    const retained = []
    cursor = 0
    do {
      const response = await request(`/api/projects/${id}/imported-archive?after=${cursor}`, a)
      assert.equal(response.status, 200)
      const page = await response.json()
      assert.equal(page.provenance, 'imported-unverified'); assert.deepEqual(page.manifest, manifest); assert.equal(page.digest, header.digest)
      retained.push(...page.records); cursor = page.nextCursor
    } while (cursor !== null)
    assert.deepEqual(retained, envelopes, 'All original record bytes must survive the full export/import round trip')
    assert.equal((await request(`/api/projects/${id}/files`, a, 'PUT', { files: [{ path: 'main.ts', content: 'newer saved edit', revision: 1 }] })).status, 200)
    assert.equal((await request(path, a, 'POST', {})).status, 200)
    assert.equal((await request(path, a, 'DELETE')).status, 200)
    assert.equal((await admin.from('source_files').select('content').eq('project_id', id).single()).data.content, 'newer saved edit')
    assert.equal((await request(`/api/projects/${originalId}/archives/${exportId}`, a, 'DELETE')).status, 200)
    let currentId = id
    for (let generation = 1; generation <= 2; generation++) {
      const nextExport = randomUUID(), nextImport = randomUUID()
      recoveredIds.push(nextImport)
      const prepared = await request(`/api/projects/${currentId}/archives`, a, 'POST', { archiveId: nextExport })
      assert.equal(prepared.status, 201)
      const { formatVersion: version, ...receipt } = await prepared.json()
      assert.equal(version, 3)
      const combined = []
      cursor = 0
      do {
        const response = await request(`/api/projects/${currentId}/archives/${nextExport}?after=${cursor}`, a)
        assert.equal(response.status, 200)
        const page = await response.json()
        for (const record of page.records) { assert.equal(hash(record.record), record.sha256); combined.push(record) }
        cursor = page.nextCursor
      } while (cursor !== null)
      assert.equal(combined.filter(record => JSON.parse(record.record).kind === 'archive-section').length, generation)
      for (const original of envelopes) assert.equal(combined.filter(record => record.sectionId === manifest.id && record.record === original.record).length, 1)
      const nextManifest = { ...receipt, format: 'codetutor-project-archive', version, scope: 'saved-project', includesUnsavedDrafts: false, includesLiveSandboxFiles: false }
      const begun = await request('/api/projects/archive-imports', a, 'POST', { id: nextImport, manifest: nextManifest, digest: hash(combined.map(record => digestLine(record, version)).join('')) })
      assert.equal(begun.status, 201)
      const nextPath = `/api/projects/archive-imports/${nextImport}`
      assert.equal((await request(nextPath, a, 'PUT', { records: combined })).status, 200)
      assert.equal((await request(nextPath, a, 'POST', {})).status, 200)
      assert.equal((await admin.from('source_files').select('content').eq('project_id', nextImport).single()).data.content, 'newer saved edit')
      assert.equal((await admin.from('messages').select('id').eq('project_id', nextImport)).data.length, 0)
      const evidence = await request(`/api/projects/${nextImport}/imported-archive`, a)
      assert.equal(evidence.status, 200)
      assert.deepEqual((await evidence.json()).records, combined)
      assert.equal((await request(`/api/projects/${nextImport}/imported-archive`, b)).status, 404)
      assert.equal((await request(`/api/projects/${currentId}/archives/${nextExport}`, a, 'DELETE')).status, 200)
      currentId = nextImport
    }
    assert.equal((await request(`/api/projects/${id}`, a, 'DELETE')).status, 200)
    assert.equal((await request(path, a, 'POST', {})).status, 410)
    assert.equal((await request(`/api/projects/${id}/imported-archive`, a)).status, 404)
    console.log('PASS: real export → import → two combined re-export/recovery cycles; exact historical bytes, latest source, cookie auth, CSRF, IDOR, corruption, concurrent commits, non-replayed tools and deletion.')
  } finally {
    for (const projectId of [id, originalId, ...recoveredIds].filter(Boolean)) assert.equal((await admin.from('projects').delete().eq('id', projectId).eq('user_id', a.id)).error, null)
  }
}
