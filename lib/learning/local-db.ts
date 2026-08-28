'use client'

// Device cache and legacy import storage. Cloud-backed operations live in db.ts.

import { safeValidateUIMessages, type UIMessage } from 'ai'
import { dataPartSchema } from '@/ai/messages/data-parts'
import { openDB, type DBSchema } from 'idb'
import type {
  ActivityManifest,
  Attempt,
  ChatRecord,
  FileSnapshot,
  LearningProject,
  PortfolioDocument,
  ProgressRecord,
} from './types'
import {
  activityManifestSchema,
  learningProjectSchema,
  portfolioDocumentSchema,
} from './types'
import {
  isValidSnapshotFile,
  MAX_PROJECT_FILES,
  MAX_PROJECT_SNAPSHOT_BYTES,
  sourceByteLength,
} from './snapshots'
import { z } from 'zod'

interface CodeTutorDB extends DBSchema {
  projects: { key: string; value: LearningProject; indexes: { 'by-updated': number } }
  files: { key: string; value: FileSnapshot; indexes: { 'by-project': string } }
  attempts: { key: string; value: Attempt; indexes: { 'by-project': string; 'by-activity': string } }
  progress: { key: string; value: ProgressRecord }
  generatedActivities: { key: string; value: ActivityManifest }
  chats: { key: string; value: ChatRecord }
  portfolio: { key: 'default'; value: PortfolioDocument }
}

const DATABASE_NAME = 'codetutor-learning'
let userStorageScope: string | undefined

export function setUserStorageScope(userId: string | undefined) {
  if (userId && !z.string().uuid().safeParse(userId).success) throw new Error('Invalid account storage scope.')
  userStorageScope = userId
}

function database() {
  if (!userStorageScope && process.env.NODE_ENV !== 'test') throw new Error('Sign in before opening account data.')
  return openDB<CodeTutorDB>(userStorageScope ? `${DATABASE_NAME}:${userStorageScope}` : DATABASE_NAME, 1, {
    upgrade(db) {
      const projects = db.createObjectStore('projects', { keyPath: 'id' })
      projects.createIndex('by-updated', 'updatedAt')
      const files = db.createObjectStore('files', { keyPath: 'id' })
      files.createIndex('by-project', 'projectId')
      const attempts = db.createObjectStore('attempts', { keyPath: 'id' })
      attempts.createIndex('by-project', 'projectId')
      attempts.createIndex('by-activity', 'activityId')
      db.createObjectStore('progress', { keyPath: 'activityId' })
      db.createObjectStore('generatedActivities', { keyPath: 'id' })
      db.createObjectStore('chats', { keyPath: 'projectId' })
      db.createObjectStore('portfolio', { keyPath: 'id' })
    },
  })
}

export async function listProjects() {
  const items = await (await database()).getAll('projects')
  // Older/interrupted writes are untrusted input too. Leave damaged records on
  // disk for recovery, but never pass objects with invalid render fields to UI.
  const projects = items.flatMap((item) => {
    const parsed = learningProjectSchema.safeParse(item)
    return parsed.success ? [parsed.data] : []
  })
  if (projects.length !== items.length) console.warn('Some saved project records could not be loaded; stored data was preserved.')
  return projects.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function saveProject(project: LearningProject) {
  await (await database()).put('projects', project)
  return project
}

export async function removeProject(projectId: string) {
  const db = await database()
  const tx = db.transaction(['projects', 'files', 'attempts', 'chats'], 'readwrite')
  await tx.objectStore('projects').delete(projectId)
  await tx.objectStore('chats').delete(projectId)
  for (const file of await tx.objectStore('files').index('by-project').getAll(projectId)) {
    await tx.objectStore('files').delete(file.id)
  }
  for (const attempt of await tx.objectStore('attempts').index('by-project').getAll(projectId)) {
    await tx.objectStore('attempts').delete(attempt.id)
  }
  await tx.done
}

export async function saveFileSnapshot(
  projectId: string,
  path: string,
  content: string
) {
  return (await saveFileSnapshots(projectId, [{ path, content }])) === 1
}

export async function saveFileSnapshots(
  projectId: string,
  files: Array<{ path: string; content: string }>
) {
  if (files.length === 0) return 0

  const updatedAt = Date.now()
  const uniqueFiles = [...new Map(files.map((file) => [file.path, file])).values()]
  const candidates = uniqueFiles.flatMap(({ path, content }) => {
    if (!isValidSnapshotFile({ path, content })) return []
    const size = sourceByteLength(content)
    return [{
      id: `${projectId}:${path}`,
      projectId,
      path,
      content,
      size,
      updatedAt,
    } satisfies FileSnapshot]
  })

  const db = await database()
  const tx = db.transaction('files', 'readwrite')
  const existing = await tx.store.index('by-project').getAll(projectId)
  const byPath = new Map(existing.map((snapshot) => [snapshot.path, snapshot]))
  let totalBytes = existing.reduce((total, snapshot) => total + snapshot.size, 0)
  let totalFiles = existing.length
  const snapshots: FileSnapshot[] = []

  for (const candidate of candidates) {
    const previous = byPath.get(candidate.path)
    const nextBytes = totalBytes - (previous?.size ?? 0) + candidate.size
    const nextFiles = totalFiles + (previous ? 0 : 1)
    if (nextBytes > MAX_PROJECT_SNAPSHOT_BYTES || nextFiles > MAX_PROJECT_FILES) continue
    totalBytes = nextBytes
    totalFiles = nextFiles
    byPath.set(candidate.path, candidate)
    snapshots.push(candidate)
  }

  await Promise.all(snapshots.map((snapshot) => tx.store.put(snapshot)))
  await tx.done
  return snapshots.length
}

export async function listFileSnapshots(projectId: string) {
  const files = await (await database()).getAllFromIndex('files', 'by-project', projectId)
  if (files.some((file) => typeof file.path !== 'string' || typeof file.content !== 'string' || !isValidSnapshotFile(file))) {
    throw new Error('A saved source snapshot is invalid. The stored files have not been changed.')
  }
  return files
}

export async function saveGeneratedActivity(activity: ActivityManifest) {
  await (await database()).put(
    'generatedActivities',
    activityManifestSchema.parse(activity)
  )
}

export async function getGeneratedActivity(id: string) {
  const parsed = activityManifestSchema.safeParse(await (await database()).get('generatedActivities', id))
  return parsed.success ? parsed.data : undefined
}

export async function saveAttempt(attempt: Attempt) {
  const db = await database()
  const tx = db.transaction(['attempts', 'progress'], 'readwrite')
  await tx.objectStore('attempts').put(attempt)
  const previous = await tx.objectStore('progress').get(attempt.activityId)
  await tx.objectStore('progress').put({
    activityId: attempt.activityId,
    attempts: (previous?.attempts ?? 0) + 1,
    completed: (previous?.completed ?? false) || attempt.passed,
    bestScore: Math.max(previous?.bestScore ?? 0, attempt.score),
    concepts: attempt.passed
      ? [...new Set([...(previous?.concepts ?? []), ...attempt.concepts])]
      : previous?.concepts ?? [],
    updatedAt: Date.now(),
  })
  await tx.done
}

export async function listProgress() {
  const items = await (await database()).getAll('progress')
  return items.flatMap((item) => {
    const parsed = storedProgressSchema.safeParse(item)
    return parsed.success ? [parsed.data] : []
  })
}

const storedProgressSchema = z.object({
  activityId: z.string(),
  attempts: z.number().int().nonnegative(),
  completed: z.boolean(),
  bestScore: z.number().min(0).max(100),
  concepts: z.array(z.string()),
  updatedAt: z.number().finite().nonnegative(),
})

export async function loadChat(projectId: string) {
  const record = await (await database()).get('chats', projectId)
  return parseStoredChatMessages(record?.messages)
}

export async function parseStoredChatMessages(input: unknown) {
  if (!Array.isArray(input)) return []

  const messages: UIMessage[] = []
  for (const candidate of input.slice(-200)) {
    const result = await safeValidateUIMessages<UIMessage>({
      messages: [candidate],
    })
    if (!result.success) continue

    const message = result.data[0]
    const parts = message.parts.filter(isRenderableStoredPart)
    if (parts.length === 0) continue

    const rawModel =
      message.metadata && typeof message.metadata === 'object'
        ? (message.metadata as { model?: unknown }).model
        : undefined
    const model =
      typeof rawModel === 'string' && rawModel.trim()
        ? rawModel.slice(0, 100)
        : undefined

    messages.push({
      ...message,
      metadata: model ? { model } : undefined,
      parts,
    })
  }

  return messages
}

function isRenderableStoredPart(part: UIMessage['parts'][number]) {
  if (part.type.startsWith('data-')) {
    const name = part.type.slice(5) as keyof typeof dataPartSchema.shape
    const schema = dataPartSchema.shape[name]
    const data = (part as { data?: unknown }).data
    return Boolean(schema?.safeParse(data).success)
  }

  if (part.type === 'tool-readFiles' && 'input' in part) {
    const input = part.input
    if (typeof input === 'undefined') return true
    if (!input || typeof input !== 'object') return false
    const paths = (input as { paths?: unknown }).paths
    return (
      Array.isArray(paths) &&
      paths.length <= 16 &&
      paths.every((path) => typeof path === 'string')
    )
  }

  return true
}

export async function saveChat(projectId: string, messages: UIMessage[]) {
  await (await database()).put('chats', {
    projectId,
    messages: structuredClone(messages),
    updatedAt: Date.now(),
  })
}

export async function loadPortfolio(): Promise<PortfolioDocument> {
  const stored = await (await database()).get('portfolio', 'default')
  const parsed = portfolioDocumentSchema.safeParse(stored)
  return parsed.success
    ? parsed.data
    : {
      id: 'default',
      displayName: '',
      headline: 'Developer who learns by building',
      bio: '',
      skills: [],
      projects: [],
      updatedAt: Date.now(),
    }
}

export async function savePortfolio(portfolio: PortfolioDocument) {
  await (await database()).put('portfolio', portfolioDocumentSchema.parse(portfolio))
}

export interface ProjectExport {
  version: 1
  exportedAt: number
  project: LearningProject
  files: FileSnapshot[]
}

const importedFileSchema = z.object({
  path: z.string(),
  content: z.string(),
}).passthrough()

const projectExportSchema = z.object({
  version: z.literal(1),
  exportedAt: z.number().finite().nonnegative(),
  project: learningProjectSchema,
  files: z.array(importedFileSchema).max(MAX_PROJECT_FILES),
})

export function parseProjectExport(input: unknown): ProjectExport {
  const parsed = projectExportSchema.safeParse(input)
  if (!parsed.success) throw new Error('Unsupported or invalid project file')

  const seen = new Set<string>()
  let totalBytes = 0
  const files: FileSnapshot[] = parsed.data.files.map((file) => {
    if (!isValidSnapshotFile(file) || seen.has(file.path)) {
      throw new Error('Project contains an invalid or duplicate source file')
    }
    seen.add(file.path)
    const size = sourceByteLength(file.content)
    totalBytes += size
    if (totalBytes > MAX_PROJECT_SNAPSHOT_BYTES) {
      throw new Error('Project source snapshot exceeds the 10 MB import limit')
    }
    return {
      id: `${parsed.data.project.id}:${file.path}`,
      projectId: parsed.data.project.id,
      path: file.path,
      content: file.content,
      size,
      updatedAt: parsed.data.exportedAt,
    }
  })

  return { ...parsed.data, files }
}

export async function exportProject(project: LearningProject): Promise<ProjectExport> {
  return {
    version: 1,
    exportedAt: Date.now(),
    project,
    files: await listFileSnapshots(project.id),
  }
}

export async function importProject(input: unknown) {
  const data = parseProjectExport(input)
  const now = Date.now()
  const id = crypto.randomUUID()
  const project: LearningProject = {
    ...data.project,
    id,
    title: `${data.project.title} (imported)`.slice(0, 80),
    sandboxId: undefined,
    previewUrl: undefined,
    createdAt: now,
    updatedAt: now,
  }
  await saveProject(project)
  await saveFileSnapshots(id, data.files)
  return project
}
