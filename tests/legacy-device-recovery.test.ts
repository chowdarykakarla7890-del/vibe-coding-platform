import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { openDB, type IDBPDatabase } from 'idb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listLegacyProjects, readLegacyProject, type LegacySnapshot } from '@/lib/learning/legacy-device-db'
import { legacySnapshotArchive, prepareLegacyArchive } from '@/lib/learning/legacy-device-archive'
import { readArchive, inspectArchive } from '@/lib/projects/archive-import'

const stores = ['projects', 'files', 'attempts', 'chats', 'generatedActivities', 'progress', 'portfolio']
const stamp = Date.parse('2026-08-01T00:00:00Z')
const project = { id: 'old-project-a', title: 'My device project', mode: 'practice', status: 'completed', language: 'TypeScript', activityId: 'activity-a', createdAt: stamp, updatedAt: stamp, sandboxId: 'do-not-import-runtime', previewUrl: 'https://old.vercel.run' }
const file = { id: `${project.id}:src/main.ts`, projectId: project.id, path: 'src/main.ts', content: 'export const greeting = "hello 😀"', size: 35, updatedAt: stamp }
const attempt = { id: 'attempt-a', projectId: project.id, activityId: 'activity-a', score: 100, passed: true, feedback: ['old feedback'], concepts: ['arrays'], createdAt: stamp }
const message = { id: 'message-a', role: 'assistant', parts: [{ type: 'tool-runCommand', input: { command: 'do not execute', sandboxId: 'old-vm', accessToken: 'secret' } }, { type: 'future-unknown-part', data: 'keep this history' }] }
function fixture(): LegacySnapshot {
  return { project: { ...project }, files: [{ ...file }], attempts: [{ ...attempt }], chat: { projectId: project.id, messages: [message], updatedAt: stamp },
    generatedActivities: [{ id: 'activity-a', instructions: ['original activity'] }], progress: [{ activityId: 'activity-a', bestScore: 100 }], portfolio: { id: 'default', displayName: 'Learner', projects: [{ projectId: project.id, screenshot: 'data:image/png;base64,AAAA', demoUrl: 'https://example.com' }] } }
}
const connections: IDBPDatabase[] = []
async function database(name = 'codetutor-learning', version = 1) {
  const db = await openDB(name, version, { upgrade(db) {
    db.createObjectStore('projects', { keyPath: 'id' })
    for (const name of ['files', 'attempts']) db.createObjectStore(name, { keyPath: 'id' }).createIndex('by-project', 'projectId')
    db.createObjectStore('chats', { keyPath: 'projectId' })
    db.createObjectStore('generatedActivities', { keyPath: 'id' })
    db.createObjectStore('progress', { keyPath: 'activityId' })
    db.createObjectStore('portfolio', { keyPath: 'id' })
  } })
  connections.push(db)
  return db
}
async function seed(db: IDBPDatabase, snapshot = fixture()) {
  const tx = db.transaction(stores, 'readwrite')
  await tx.objectStore('projects').put(snapshot.project)
  for (const [store, values] of [['files', snapshot.files], ['attempts', snapshot.attempts], ['generatedActivities', snapshot.generatedActivities], ['progress', snapshot.progress]] as const) {
    for (const value of values) await tx.objectStore(store).put(value)
  }
  if (snapshot.chat) await tx.objectStore('chats').put(snapshot.chat)
  if (snapshot.portfolio) await tx.objectStore('portfolio').put(snapshot.portfolio)
  await tx.done
}
async function records(blob: Blob) {
  const output: Array<{ kind: string; key: string; data: Record<string, unknown> }> = []
  for await (const item of readArchive(blob, new AbortController().signal)) if (item.type === 'record') output.push(JSON.parse(item.envelope.record))
  return output
}
beforeEach(() => { vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Recovery must not use the network') })) })
afterEach(() => { for (const db of connections.splice(0)) db.close(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('read-only legacy discovery', () => {
  it('does not create a database when the old device store is absent', async () => {
    expect(await listLegacyProjects(new AbortController().signal)).toEqual({ projects: [], nextCursor: null })
    expect(await indexedDB.databases()).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })
  it('never searches account-scoped caches', async () => {
    const db = await database('codetutor-learning:11111111-1111-4111-8111-111111111111')
    await seed(db)
    expect((await listLegacyProjects(new AbortController().signal)).projects).toHaveLength(0)
    expect(await indexedDB.databases()).toHaveLength(1)
    expect(await db.get('projects', project.id)).toEqual(project)
  })
  it('paginates by key and exposes invalid rows without deleting or hiding them', async () => {
    const db = await database()
    const tx = db.transaction('projects', 'readwrite')
    for (let index = 0; index < 51; index++) await tx.store.put({ ...project, id: `p-${String(index).padStart(2, '0')}`, ...(index === 50 ? { title: { broken: true } } : {}) })
    await tx.done
    const first = await listLegacyProjects(new AbortController().signal)
    expect(first.projects).toHaveLength(50)
    expect(first.nextCursor).toBe('p-49')
    const second = await listLegacyProjects(new AbortController().signal, first.nextCursor!)
    expect(second.projects).toEqual([{ id: 'p-50', title: 'Unreadable device project', language: 'Unknown', readable: false }])
    expect(second.nextCursor).toBeNull()
    expect(await db.count('projects')).toBe(51)
  })
  it('rejects unsupported versions rather than upgrading or mutating them', async () => {
    const db = await database('codetutor-learning', 2)
    await expect(listLegacyProjects(new AbortController().signal)).rejects.toThrow(/unsupported structure/)
    expect(db.version).toBe(2)
  })
  it('preserves every selected record and excludes unrelated portfolio/projects', async () => {
    const db = await database()
    const data = fixture()
    data.chat = { projectId: project.id, messages: Array.from({ length: 305 }, (_, i) => ({ ...message, id: `message-${i}` })), updatedAt: stamp }
    data.portfolio = { id: 'default', displayName: 'Learner', projects: [{ projectId: project.id, title: 'selected' }, { projectId: 'other', title: 'private other project' }] }
    await seed(db, data)
    await db.put('files', { ...file, id: 'other:secret.ts', projectId: 'other', path: 'secret.ts' })
    await db.put('attempts', { ...attempt, id: 'other-attempt', projectId: 'other' })
    const before = await Promise.all(stores.map(store => db.getAll(store)))
    const spy = vi.spyOn(IDBDatabase.prototype, 'transaction')
    const backup = await prepareLegacyArchive(project.id, new AbortController().signal)
    expect(backup.fileCount).toBe(1); expect(backup.messageCount).toBe(305); expect(backup.attemptCount).toBe(1)
    expect(spy.mock.calls.every(call => call[1] === 'readonly')).toBe(true)
    const result = await records(backup.blob)
    expect(result.filter(row => row.kind === 'message')).toHaveLength(305)
    expect(result.find(row => row.kind === 'source')?.data.content).toBe(file.content)
    expect(result.find(row => row.kind === 'portfolio-project')?.data.value).toEqual({ id: 'default', displayName: 'Learner', projects: [{ projectId: project.id, title: 'selected' }] })
    expect(result.find(row => row.key === 'legacy-progress:0')?.data.sharedActivitySummary).toBe(true)
    expect(await Promise.all(stores.map(store => db.getAll(store)))).toEqual(before)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('honors cancellation before opening any database', async () => {
    const controller = new AbortController(); controller.abort()
    const opened = vi.spyOn(indexedDB, 'open')
    await expect(readLegacyProject(project.id, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(opened).not.toHaveBeenCalled()
  })
  it('reports a storage failure instead of treating it as an empty account', async () => {
    vi.spyOn(indexedDB, 'open').mockImplementation(() => { throw new DOMException('Storage denied', 'SecurityError') })
    await expect(listLegacyProjects(new AbortController().signal)).rejects.toMatchObject({ name: 'SecurityError' })
  })
  it('bounds a stalled open and closes a connection delivered after the timeout', async () => {
    vi.useFakeTimers()
    const request = {} as IDBOpenDBRequest
    vi.spyOn(indexedDB, 'open').mockReturnValue(request)
    let outcome = 'pending'
    const result = listLegacyProjects(new AbortController().signal).then(() => { outcome = 'resolved' }, (error: Error) => { outcome = error.message })
    await vi.advanceTimersByTimeAsync(15_001)
    expect(outcome).toMatch(/timed out/)
    await result
    const close = vi.fn()
    Object.defineProperty(request, 'result', { value: { version: 1, objectStoreNames: { contains: () => true }, close } })
    request.onsuccess?.call(request, new Event('success'))
    expect(close).toHaveBeenCalledOnce()
  })
  it('aborts an in-flight readonly transaction without altering the old database', async () => {
    const db = await database(); await seed(db)
    const controller = new AbortController()
    const original = IDBIndex.prototype.openCursor
    vi.spyOn(IDBIndex.prototype, 'openCursor').mockImplementation(function (this: IDBIndex, ...args) {
      const request = original.apply(this, args)
      queueMicrotask(() => controller.abort())
      return request
    })
    await expect(readLegacyProject(project.id, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(await db.get('files', file.id)).toEqual(file)
    expect(await db.get('chats', project.id)).toEqual(fixture().chat)
  })
  it('rejects oversized file sets without deleting any source', async () => {
    const db = await database(), data = fixture()
    data.files = Array.from({ length: 201 }, (_, i) => ({ ...file, id: `${project.id}:${i}.ts`, path: `${i}.ts` }))
    await seed(db, data)
    await expect(prepareLegacyArchive(project.id, new AbortController().signal)).rejects.toThrow(/limits/)
    expect(await db.count('files')).toBe(201)
  })
})

describe('complete portable legacy archives', () => {
  it('produces deterministic resumable v3 archives without executable tool history or VM credentials', async () => {
    const first = await legacySnapshotArchive(fixture(), new AbortController().signal)
    const second = await legacySnapshotArchive(fixture(), new AbortController().signal)
    expect(await first.blob.text()).toBe(await second.blob.text())
    expect((await inspectArchive(first.blob, new AbortController().signal)).digest).toBe(first.digest)
    expect(first.manifest.version).toBe(3)
    const all = await records(first.blob)
    expect(all.find(row => row.key === 'legacy-project')?.data.value).toMatchObject({ id: project.id, title: project.title })
    expect(all.filter(row => row.kind === 'message')).toEqual([{ kind: 'message', key: 'legacy:00000000', data: { origin: 'legacy-device', value: { ...message, parts: [{ type: 'tool-runCommand', input: { command: 'do not execute' } }, message.parts[1]] } } }])
    expect(await first.blob.text()).not.toMatch(/accessToken|sandboxId|previewUrl|do-not-import-runtime/)
    expect(fetch).not.toHaveBeenCalled()
    const changed = fixture(); changed.files = [{ ...file, content: 'changed' }]
    expect((await legacySnapshotArchive(changed, new AbortController().signal)).digest).not.toBe(first.digest)
  })
  it.each([
    ['unsafe source path', (data: LegacySnapshot) => { data.files = [{ ...file, path: '../secrets' }] }],
    ['file/folder collision', (data: LegacySnapshot) => { data.files = [{ ...file, path: 'src' }, file] }],
    ['duplicate source', (data: LegacySnapshot) => { data.files = [file, file] }],
    ['foreign project file', (data: LegacySnapshot) => { data.files = [{ ...file, projectId: 'other' }] }],
    ['foreign chat', (data: LegacySnapshot) => { data.chat = { projectId: 'other', messages: [] } }],
    ['foreign attempt', (data: LegacySnapshot) => { data.attempts = [{ ...attempt, projectId: 'other' }] }],
    ['unsafe JSON key', (data: LegacySnapshot) => { data.chat = { projectId: project.id, messages: [JSON.parse('{"__proto__":{"bad":true}}')] } }],
    ['non-JSON value', (data: LegacySnapshot) => { data.chat = { projectId: project.id, messages: [new Map([['a', 1]])] } }],
    ['oversized message', (data: LegacySnapshot) => { data.chat = { projectId: project.id, messages: [{ text: 'x'.repeat(2 * 1024 * 1024) }] } }],
    ['invalid Unicode', (data: LegacySnapshot) => { data.files = [{ ...file, content: '\uD800' }] }],
  ] as const)('fails the entire backup for %s instead of silently omitting data', async (_label, change) => {
    const data = fixture(); change(data)
    await expect(legacySnapshotArchive(data, new AbortController().signal)).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })
  it('preserves prose and source exactly, rather than pretending to scan all secrets', async () => {
    const data = fixture(); data.files = [{ ...file, content: 'const accessToken = "user-supplied-content"' }]
    const all = await records((await legacySnapshotArchive(data, new AbortController().signal)).blob)
    expect(all.find(row => row.kind === 'source')?.data.content).toBe('const accessToken = "user-supplied-content"')
  })
})
