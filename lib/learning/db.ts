'use client'

import { z } from 'zod'
import * as cache from './local-db'
import { cloudOperation, setCloudAccount } from './cloud-request'
import { projectResponseSchema, projectsResponseSchema } from '@/lib/projects/serialization'
import { activityManifestSchema, portfolioDocumentSchema, sourceFileSchema, type ActivityManifest, type ProgressRecord, type FileSnapshot, type LearningProject, type PortfolioDocument } from './types'
import { activitiesPageSchema, progressPageSchema } from './cloud-schemas'
import { isValidSnapshotFile, MAX_PROJECT_FILES, MAX_PROJECT_SNAPSHOT_BYTES, sourceByteLength } from './snapshots'
import { chatPageSchema, decodeChatRows, type chatRowSchema } from '@/lib/chat/serialization'
import { importSourceProject } from './source-import'

// The old device database is preserved for explicit legacy imports only.
export { parseStoredChatMessages, parseProjectExport } from './local-db'
export type { ProjectExport } from './local-db'

export function setUserStorageScope(userId: string | undefined) {
  setCloudAccount(userId)
  cache.setUserStorageScope(userId)
}

const acknowledged = z.object({ saved: z.number().int().nonnegative() })
const deleted = z.object({ deleted: z.literal(true) })
const filePageSchema = z.object({
  files: z.array(sourceFileSchema.extend({ updatedAt: z.number().finite(), revision: z.number().int().positive() })).max(MAX_PROJECT_FILES),
  nextCursor: z.string().nullable(),
})

export async function listProgress(signal?: AbortSignal): Promise<ProgressRecord[]> {
  const operation = cloudOperation(signal)
  const progress: ProgressRecord[] = []
  const seen = new Set<string>()
  let cursor: string | null = null
  do {
    const page: z.infer<typeof progressPageSchema> = await operation.request(`/api/progress${cursor ? `?after=${encodeURIComponent(cursor)}` : ''}`, progressPageSchema)
    progress.push(...page.progress)
    cursor = page.nextCursor
    if (cursor && seen.has(cursor)) throw new Error('Progress pagination could not advance.')
    if (cursor) seen.add(cursor)
  } while (cursor)
  return progress
}

export async function listGeneratedActivities(signal?: AbortSignal): Promise<ActivityManifest[]> {
  const operation = cloudOperation(signal)
  const activities: ActivityManifest[] = []
  const seen = new Set<string>()
  let cursor: string | null = null
  do {
    const page: z.infer<typeof activitiesPageSchema> = await operation.request(`/api/activities${cursor ? `?after=${encodeURIComponent(cursor)}` : ''}`, activitiesPageSchema)
    activities.push(...page.activities)
    cursor = page.nextCursor
    if (cursor && seen.has(cursor)) throw new Error('Activity pagination could not advance.')
    if (cursor) seen.add(cursor)
  } while (cursor)
  return activities
}

export async function getGeneratedActivity(id: string, signal?: AbortSignal) {
  const result = await cloudOperation(signal).request(`/api/activities/${encodeURIComponent(id)}`, z.object({ activity: activityManifestSchema.nullable() }))
  return result.activity ?? undefined
}

export async function listProjects(signal?: AbortSignal) {
  const operation = cloudOperation(signal)
  const projects: LearningProject[] = []
  let cursor: string | null = null
  const cursors = new Set<string>()
  do {
    const page: z.output<typeof projectsResponseSchema> = await operation.request(`/api/projects${cursor ? `?after=${encodeURIComponent(cursor)}` : ''}`, projectsResponseSchema)
    projects.push(...page.projects)
    cursor = page.nextCursor ?? null
    if (cursor && cursors.has(cursor)) throw new Error('Project pagination could not advance.')
    if (cursor) cursors.add(cursor)
  } while (cursor)
  operation.assertActive()
  return projects.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function loadChat(projectId: string, signal?: AbortSignal) {
  const operation = cloudOperation(signal)
  let rows: z.output<typeof chatRowSchema>[] = []
  let cursor: number | null = null
  const seen = new Set<number>()
  do {
    const page: z.output<typeof chatPageSchema> = await operation.request(`/api/projects/${projectId}/messages${cursor ? `?before=${cursor}` : ''}`, chatPageSchema)
    rows = [...page.messages, ...rows]
    if (page.nextCursor && seen.has(page.nextCursor)) throw new Error('Conversation pagination could not advance.')
    cursor = page.nextCursor
    if (cursor) seen.add(cursor)
  } while (cursor && rows.length < 200)
  return decodeChatRows(rows.slice(-200))
}

export async function stopProjectChat(projectId: string, messageId: string, requestId: string, signal?: AbortSignal) {
  await cloudOperation(signal).request(`/api/projects/${projectId}/messages/stop`, z.object({ stopped: z.literal(true) }), 'POST', { messageId, requestId })
}

export async function createProject(project: LearningProject, signal?: AbortSignal) {
  const operation = cloudOperation(signal)
  const result = await operation.request('/api/projects', projectResponseSchema, 'POST', {
    id: project.id, title: project.title, mode: project.mode,
    language: project.language, activityId: project.activityId,
  })
  operation.assertActive()
  // Cloud storage has already committed. A blocked device cache must not keep
  // project creation (or restoration below) waiting indefinitely. Invoke now
  // to capture this account's cache before any account switch; observe errors.
  void cache.saveProject(result.project).catch(() => undefined)
  return result.project
}

export async function saveProject(project: LearningProject, signal?: AbortSignal) {
  const operation = cloudOperation(signal)
  const result = await operation.request(`/api/projects/${project.id}`, projectResponseSchema, 'PATCH', {
    title: project.title, mode: project.mode, language: project.language,
    status: project.status, activityId: project.activityId ?? null,
  })
  operation.assertActive()
  // Sandbox ownership comes only from the server's registered sessions. A
  // device cache must not replace that association after reload/account switch.
  void cache.saveProject(result.project).catch(() => undefined)
  return result.project
}

export async function removeProject(projectId: string) {
  const operation = cloudOperation()
  await operation.request(`/api/projects/${projectId}`, deleted, 'DELETE')
  operation.assertActive()
  void cache.removeProject(projectId).catch(() => undefined)
}

export async function saveFileSnapshot(projectId: string, path: string, content: string) {
  return (await saveFileSnapshots(projectId, [{ path, content }])) === 1
}

export async function saveFileSnapshots(projectId: string, input: Array<{ path: string; content: string; revision?: number }>) {
  const files = [...new Map(input.map((file) => [file.path, file])).values()]
  if (!files.length) return 0
  if (files.length > MAX_PROJECT_FILES || files.some((file) => !isValidSnapshotFile(file)) || files.reduce((sum, file) => sum + sourceByteLength(file.content), 0) > MAX_PROJECT_SNAPSHOT_BYTES) {
    throw new Error('Source snapshot exceeds the supported file or project limits.')
  }
  const operation = cloudOperation()
  let saved = 0
  let batch: typeof files = []
  let bytes = 0
  async function flush() {
    if (!batch.length) return
    const result = await operation.request(`/api/projects/${projectId}/files`, acknowledged, 'PUT', { files: batch })
    if (result.saved !== batch.length) throw new Error('Cloud storage did not acknowledge every saved file.')
    saved += result.saved
    batch = []
    bytes = 0
  }
  for (const file of files) {
    const size = sourceByteLength(JSON.stringify(file)) + 1
    if (batch.length && bytes + size > 2 * 1024 * 1024) await flush()
    batch.push(file)
    bytes += size
  }
  await flush()
  return saved
}

export async function listFileSnapshots(projectId: string, signal?: AbortSignal): Promise<FileSnapshot[]> {
  const operation = cloudOperation(signal)
  const files: FileSnapshot[] = []
  const cursors = new Set<string>()
  let cursor: string | null = null
  do {
    const page: z.output<typeof filePageSchema> = await operation.request(`/api/projects/${projectId}/files${cursor ? `?after=${encodeURIComponent(cursor)}` : ''}`, filePageSchema)
    files.push(...page.files.map((file) => ({ ...file, id: `${projectId}:${file.path}`, projectId, size: sourceByteLength(file.content) })))
    cursor = page.nextCursor
    if (files.length > MAX_PROJECT_FILES || (cursor && cursors.has(cursor))) throw new Error('Source snapshot pagination is invalid.')
    if (cursor) cursors.add(cursor)
  } while (cursor)
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_PROJECT_SNAPSHOT_BYTES || new Set(files.map((file) => file.path)).size !== files.length) throw new Error('Source snapshot exceeds project limits.')
  return files
}

export async function loadPortfolio(): Promise<PortfolioDocument> {
  const { portfolio } = await cloudOperation().request('/api/portfolio', z.object({ portfolio: portfolioDocumentSchema.nullable() }))
  return portfolio ?? { id: 'default', displayName: '', headline: 'Developer who learns by building', bio: '', skills: [], projects: [], updatedAt: Date.now() }
}

export async function savePortfolio(portfolio: PortfolioDocument) {
  await cloudOperation().request('/api/portfolio', z.object({ saved: z.literal(true) }), 'PUT', portfolioDocumentSchema.parse(portfolio))
}

export async function exportProject(project: LearningProject): Promise<cache.ProjectExport> {
  return { version: 1, exportedAt: Date.now(), project: { ...project, sandboxId: undefined, previewUrl: undefined }, files: await listFileSnapshots(project.id) }
}

export async function importProject(input: unknown, signal?: AbortSignal) {
  return importSourceProject(input, signal ?? new AbortController().signal)
}
