'use client'

import { wrap, type IDBPDatabase, type IDBPIndex } from 'idb'
import { z } from 'zod'
import { readWithDeadline } from '@/lib/abortable-read'
import { MAX_ARCHIVE_BYTES } from '@/lib/projects/archive'
import { learningProjectSchema } from './types'
import { sourceByteLength } from './snapshots'

// Deliberately fixed. Account caches must never be searched or claimed through
// this migration. Opening without a version also never upgrades existing data.
const LEGACY_DATABASE = 'codetutor-learning'
const stores = ['projects', 'files', 'attempts', 'chats', 'generatedActivities', 'progress', 'portfolio']
const projectIdSchema = z.string().min(1).max(128)
const objectSchema = z.record(z.unknown())

export interface LegacyProjectPage {
  projects: Array<{ id: string; title: string; language: string; readable: boolean }>
  nextCursor: string | null
}
export interface LegacySnapshot {
  project: unknown
  files: unknown[]
  attempts: unknown[]
  chat?: unknown
  generatedActivities: unknown[]
  progress: unknown[]
  portfolio?: unknown
}

function openLegacy(signal: AbortSignal): Promise<IDBPDatabase | undefined> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    if (typeof indexedDB === 'undefined') throw new Error('Device storage is unavailable in this browser.')
    const request = indexedDB.open(LEGACY_DATABASE)
    let finished = false, absent = false
    function finish(error?: unknown, db?: IDBDatabase) {
      if (finished) { db?.close(); return }
      finished = true
      signal.removeEventListener('abort', cancel)
      if (error) { db?.close(); reject(error) }
      else resolve(db ? wrap(db) : undefined)
    }
    function cancel() { finish(signal.reason) }
    signal.addEventListener('abort', cancel, { once: true })
    // Abort creation, including its version-change transaction, if no legacy
    // database exists. Merely checking for old work must not create a database.
    request.onupgradeneeded = () => { absent = true; request.transaction?.abort() }
    request.onblocked = () => finish(new Error('Device storage is busy. Close other CodeTutor tabs and retry; do not clear site data.'))
    request.onerror = () => finish(absent ? undefined : new Error('Device storage could not be opened. No saved data was changed.'))
    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => db.close()
      if (db.version !== 1 || stores.some(store => !db.objectStoreNames.contains(store))) {
        finish(new Error('This device database has an unsupported structure. It has not been upgraded or changed.'), db)
      } else finish(undefined, db)
    }
  })
}

async function readLegacy<T>(signal: AbortSignal, read: (db: IDBPDatabase, signal: AbortSignal) => Promise<T>) {
  return readWithDeadline(async deadline => {
    const db = await openLegacy(deadline)
    if (!db) return undefined
    try { return await read(db, deadline) } finally { db.close() }
  }, signal, 15_000, 'Reading device storage timed out. Retry without clearing site data.')
}

export async function listLegacyProjects(signal: AbortSignal, after?: string): Promise<LegacyProjectPage> {
  if (after !== undefined) projectIdSchema.parse(after)
  return await readLegacy(signal, async (db, deadline) => {
    const tx = db.transaction('projects', 'readonly')
    const cancel = () => { try { tx.abort() } catch { /* already settled */ } }
    deadline.addEventListener('abort', cancel, { once: true })
    void tx.done.catch(() => undefined)
    try {
      const projects: LegacyProjectPage['projects'] = []
      let cursor = await tx.store.openCursor(after ? IDBKeyRange.lowerBound(after, true) : undefined)
      while (cursor && projects.length < 50) {
        const id = projectIdSchema.parse(cursor.primaryKey)
        const parsed = learningProjectSchema.safeParse(cursor.value)
        const readable = parsed.success && parsed.data.id === id
        projects.push({ id, readable, title: readable ? parsed.data.title : 'Unreadable device project', language: readable ? parsed.data.language : 'Unknown' })
        cursor = await cursor.continue()
      }
      await tx.done
      deadline.throwIfAborted()
      return { projects, nextCursor: cursor ? projects.at(-1)!.id : null }
    } catch (error) { cancel(); throw error } finally { deadline.removeEventListener('abort', cancel) }
  }) ?? { projects: [], nextCursor: null }
}

async function collect<Name extends string>(index: IDBPIndex<unknown, string[], Name, 'by-project', 'readonly'>, projectId: string, limit: number, charge: (value: unknown) => void) {
  const records: unknown[] = []
  let cursor = await index.openCursor(projectId)
  while (cursor) {
    if (records.length >= limit) throw new Error('This device project exceeds the supported recovery limits. Nothing was imported or deleted.')
    const value: unknown = cursor.value
    if (objectSchema.parse(value).projectId !== projectId) throw new Error('Device project records are inconsistent. Nothing was imported.')
    charge(value)
    records.push(value)
    cursor = await cursor.continue()
  }
  return records
}

/** One readonly transaction captures a coherent point in time. Hashing and
 * network operations happen only AFTER it finishes, never between IDB reads. */
export async function readLegacyProject(projectId: string, signal: AbortSignal): Promise<LegacySnapshot> {
  projectIdSchema.parse(projectId)
  const snapshot = await readLegacy(signal, async (db, deadline) => {
    const tx = db.transaction(stores, 'readonly')
    const cancel = () => { try { tx.abort() } catch { /* already settled */ } }
    deadline.addEventListener('abort', cancel, { once: true })
    void tx.done.catch(() => undefined)
    let bytes = 0
    function charge(value: unknown) {
      if (value === undefined) return
      let json: string
      try { json = JSON.stringify(value) } catch { throw new Error('A device record is not valid JSON. The original data is unchanged.') }
      bytes += sourceByteLength(json)
      if (bytes > MAX_ARCHIVE_BYTES) throw new Error('This device project exceeds the 256 MB recovery limit. Nothing was imported or deleted.')
    }
    try {
      const project: unknown = await tx.objectStore('projects').get(projectId)
      const parsed = learningProjectSchema.parse(project)
      if (parsed.id !== projectId) throw new Error('Device project identity is inconsistent.')
      charge(project)
      const [files, attempts, chat, portfolio] = await Promise.all([
        collect(tx.objectStore('files').index('by-project'), projectId, 200, charge),
        collect(tx.objectStore('attempts').index('by-project'), projectId, 49_000, charge),
        tx.objectStore('chats').get(projectId) as Promise<unknown>,
        tx.objectStore('portfolio').get('default') as Promise<unknown>,
      ])
      charge(chat)
      const activityIds = new Set<string>(parsed.activityId ? [parsed.activityId] : [])
      for (const attempt of attempts) activityIds.add(projectIdSchema.parse(objectSchema.parse(attempt).activityId))
      const generatedActivities: unknown[] = [], progress: unknown[] = []
      for (const id of [...activityIds].sort()) {
        const [activity, summary] = await Promise.all([
          tx.objectStore('generatedActivities').get(id) as Promise<unknown>,
          tx.objectStore('progress').get(id) as Promise<unknown>,
        ])
        if (activity !== undefined) {
          if (objectSchema.parse(activity).id !== id) throw new Error('A generated activity has inconsistent device identity.')
          charge(activity); generatedActivities.push(activity)
        }
        if (summary !== undefined) {
          if (objectSchema.parse(summary).activityId !== id) throw new Error('An activity summary has inconsistent device identity.')
          charge(summary); progress.push(summary)
        }
      }
      let selectedPortfolio: unknown
      if (portfolio !== undefined) {
        const document = z.object({ projects: z.array(z.object({ projectId: projectIdSchema }).passthrough()) }).passthrough().parse(portfolio)
        selectedPortfolio = { ...document, projects: document.projects.filter(entry => entry.projectId === projectId) }
        charge(selectedPortfolio)
      }
      await tx.done
      deadline.throwIfAborted()
      return { project, files, attempts, chat, generatedActivities, progress, portfolio: selectedPortfolio }
    } catch (error) { cancel(); throw error } finally { deadline.removeEventListener('abort', cancel) }
  })
  if (!snapshot) throw new Error('No earlier device database was found in this browser and site.')
  return snapshot
}
