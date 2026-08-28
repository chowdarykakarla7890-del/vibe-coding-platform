import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { openDB } from 'idb'
import { randomBytes } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import { expect, it, vi } from 'vitest'
import { prepareLegacyArchive } from '@/lib/learning/legacy-device-archive'
import { checkPendingArchiveImport, downloadImportedArchive, importProjectArchive } from '@/lib/learning/archive-import'
import { setCloudAccount } from '@/lib/learning/cloud-request'

// Opt-in: disposable accounts/project records only. No VM, AI, email, browser
// session, or user's real IndexedDB is accessed. Use a running local app.
it.skipIf(process.env.RUN_LIVE_LEGACY_RECOVERY !== '1')('recovers a complete device archive through cookie-authenticated HTTP with pause/resume and owner isolation', async () => {
  const base = process.env.TEST_APP_URL ?? 'http://localhost:3112'
  if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('Use a local application for the live recovery test.')
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, secret = process.env.SUPABASE_SECRET_KEY
  if (!url || !key || !secret) throw new Error('Load the configured Supabase test environment.')
  const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } })
  const users: string[] = [], clients: ReturnType<typeof createServerClient>[] = []
  const nativeFetch = fetch
  async function account() {
    const email = `legacy-recovery-${crypto.randomUUID()}@example.invalid`, password = randomBytes(24).toString('hex')
    const result = await admin.auth.admin.createUser({ email, password, email_confirm: true })
    if (result.error || !result.data.user) throw new Error('Disposable account setup failed.')
    users.push(result.data.user.id)
    const cookies = new Map<string, string>()
    const client = createServerClient(url!, key!, { cookies: {
      getAll: () => [...cookies].map(([name, value]) => ({ name, value })),
      setAll: values => values.forEach(({ name, value }) => cookies.set(name, value)),
    } })
    clients.push(client)
    if ((await client.auth.signInWithPassword({ email, password })).error) throw new Error('Disposable sign-in failed.')
    return { id: result.data.user.id, cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') }
  }
  vi.stubGlobal('indexedDB', new IDBFactory())
  const db = await openDB('codetutor-learning', 1, { upgrade(db) {
    for (const name of ['projects', 'generatedActivities', 'portfolio']) db.createObjectStore(name, { keyPath: 'id' })
    for (const name of ['files', 'attempts']) db.createObjectStore(name, { keyPath: 'id' }).createIndex('by-project', 'projectId')
    db.createObjectStore('chats', { keyPath: 'projectId' }); db.createObjectStore('progress', { keyPath: 'activityId' })
  } })
  try {
    const a = await account(), b = await account()
    const preferences = new Map<string, string>()
    vi.stubGlobal('window', { localStorage: { getItem: (key: string) => preferences.get(key) ?? null, setItem: (key: string, value: string) => preferences.set(key, value), removeItem: (key: string) => preferences.delete(key) } })
    vi.stubGlobal('fetch', (path: string | URL | Request, init?: RequestInit) => {
      if (typeof path !== 'string' || !path.startsWith('/api/')) return nativeFetch(path, init)
      const headers = new Headers(init?.headers)
      headers.set('cookie', a.cookie); headers.set('origin', base)
      return nativeFetch(new URL(path, base), { ...init, headers })
    })
    setCloudAccount(a.id)
    const projectId = 'legacy-non-uuid-project', stamp = Date.parse('2026-08-01T00:00:00Z')
    await db.put('projects', { id: projectId, title: 'Disposable device recovery', mode: 'practice', activityId: 'old-activity', language: 'TypeScript', status: 'completed', createdAt: stamp, updatedAt: stamp })
    await db.put('files', { id: `${projectId}:main.ts`, projectId, path: 'main.ts', content: 'export const hello = "original 😀"', updatedAt: stamp, size: 37 })
    const messages = Array.from({ length: 305 }, (_, i) => ({ id: `old-${i}`, role: i % 2 ? 'assistant' : 'user', parts: [{ type: 'text', text: `Original ${i}` }, { type: 'tool-runCommand', input: { command: 'never execute', accessToken: 'remove this field' } }] }))
    await db.put('chats', { projectId, messages, updatedAt: stamp })
    await db.put('attempts', { id: 'old-attempt', projectId, activityId: 'old-activity', score: 100, passed: true })
    await db.put('progress', { activityId: 'old-activity', bestScore: 100 })
    await db.put('generatedActivities', { id: 'old-activity', instructions: ['Original untrusted activity'] })
    await db.put('portfolio', { id: 'default', displayName: 'Private fixture', projects: [{ projectId, title: 'Included' }, { projectId: 'another-device-project', title: 'Excluded' }] })
    const archive = await prepareLegacyArchive(projectId, new AbortController().signal)
    expect(archive.messageCount).toBe(305)
    const stopped = new AbortController()
    await expect(importProjectArchive(archive.blob, stopped.signal, progress => {
      if (progress.phase === 'uploading' && progress.receipt.uploadedRecords > 0) stopped.abort()
    })).rejects.toMatchObject({ name: 'AbortError' })
    const pending = await checkPendingArchiveImport(new AbortController().signal)
    expect(pending?.state).toBe('uploading'); expect(pending?.uploadedRecords).toBe(20)
    expect((await admin.from('projects').select('id').eq('id', pending!.id)).data).toEqual([])
    const rePrepared = await prepareLegacyArchive(projectId, new AbortController().signal)
    expect(await rePrepared.blob.text()).toBe(await archive.blob.text())
    const saved = await importProjectArchive(rePrepared.blob, new AbortController().signal)
    expect(saved.id).toBe(pending!.id); expect(saved.mode).toBe('playground'); expect(saved.activityId).toBeUndefined()
    const retained = await downloadImportedArchive(saved.id, new AbortController().signal)
    expect(await retained.text()).toBe(await archive.blob.text())
    for (const table of ['messages', 'assessments', 'sandbox_sessions']) {
      const result = await admin.from(table).select('id').eq('project_id', saved.id)
      expect(result.error).toBeNull(); expect(result.data).toEqual([])
    }
    const crossUser = await nativeFetch(new URL(`/api/projects/${saved.id}/imported-archive`, base), { headers: { cookie: b.cookie, 'X-CodeTutor-Account': b.id }, signal: AbortSignal.timeout(20_000) })
    expect(crossUser.status).toBe(404)
    const edit = await fetch(`/api/projects/${saved.id}/files`, { method: 'PUT', headers: { 'content-type': 'application/json', 'X-CodeTutor-Account': a.id }, body: JSON.stringify({ files: [{ path: 'main.ts', content: 'newer source', revision: 1 }] }), signal: AbortSignal.timeout(20_000) })
    expect(edit.status).toBe(200)
    expect((await importProjectArchive(archive.blob, new AbortController().signal)).id).toBe(saved.id)
    const source = await admin.from('source_files').select('content').eq('project_id', saved.id).single()
    expect(source.error).toBeNull(); expect(source.data?.content).toBe('newer source')
    expect((await db.get('chats', projectId)).messages).toEqual(messages)
    expect((await db.get('files', `${projectId}:main.ts`)).content).toBe('export const hello = "original 😀"')
    console.log('PASS: complete legacy conversion, real authenticated upload, pause/resume, exact evidence, owner isolation and preserved original/newer source; no tools replayed.')
  } finally {
    setCloudAccount(undefined); db.close(); vi.unstubAllGlobals()
    for (const client of clients) if ((await client.auth.signOut({ scope: 'global' })).error) throw new Error('Temporary session cleanup needs attention.')
    for (const id of users) if ((await admin.auth.admin.deleteUser(id)).error) throw new Error('Temporary account cleanup needs attention.')
    console.log('Temporary recovery accounts and their imported projects removed; sessions signed out.')
  }
}, 180_000)
