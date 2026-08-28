'use client'

import { z } from 'zod'
import { archiveDigestLine, archiveManifestSchema, MAX_ARCHIVE_BYTES, type ArchiveEnvelope, type archiveKinds } from '@/lib/projects/archive'
import { inspectArchive, validateImportedEnvelope } from '@/lib/projects/archive-import'
import { textDigest } from '@/lib/projects/source-import'
import { readWithDeadline } from '@/lib/abortable-read'
import { learningProjectSchema } from './types'
import { sourceByteLength } from './snapshots'
import { readLegacyProject, type LegacySnapshot } from './legacy-device-db'

const privateKeys = new Set(['accesstoken', 'refreshtoken', 'authorization', 'capability', 'sandboxcapability', 'apikey', 'leasetoken', 'sandboxid', 'commandid', 'previewurl'])
const object = z.record(z.unknown())

// Match archive credential minimization. This is NOT a general secret scanner:
// prose/source remain exact and the UI warns that backups must remain private.
function evidence(root: unknown): unknown {
  let nodes = 0
  function copy(value: unknown, depth: number): unknown {
    if (++nodes > 100_000 || depth > 28) throw new Error('A device record is too deeply nested or complex to recover.')
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (Array.isArray(value)) return value.map(child => copy(child === undefined ? null : child, depth + 1))
    if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      const result: Record<string, unknown> = Object.create(null)
      for (const [key, child] of Object.entries(value)) {
        if (child === undefined || privateKeys.has(key.toLowerCase().replace(/[_-]/g, ''))) continue
        if (key.toLowerCase() === 'url' && typeof child === 'string' && /^https:\/\/[^/]+\.vercel\.run(?:[/?#]|$)/i.test(child)) continue
        result[key] = copy(child, depth + 1)
      }
      return result
    }
    throw new Error('A device record contains unsupported data. Nothing was silently omitted; the original is unchanged.')
  }
  return copy(root, 0)
}

function timestamp(value: unknown) { return new Date(z.number().finite().nonnegative().max(8.64e15).parse(value)).toISOString() }
function hashId(hash: string) { return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}` }

/** Complete legacy history becomes opaque evidence. It is intentionally never
 * passed to the normal chat parser (which truncates and validates live tools). */
export async function legacySnapshotArchive(snapshot: LegacySnapshot, signal: AbortSignal) {
  signal.throwIfAborted()
  const project = learningProjectSchema.parse(snapshot.project)
  const id = hashId(await textDigest(`codetutor-legacy-project:${project.id}`))
  const records: ArchiveEnvelope[] = []
  let payloadBytes = 0
  async function add(kind: typeof archiveKinds[number], key: string, data: unknown) {
    signal.throwIfAborted()
    const record = JSON.stringify({ kind, key, data })
    const envelope = { index: records.length + 1, record, sha256: await textDigest(record) }
    await validateImportedEnvelope(envelope)
    payloadBytes += sourceByteLength(record)
    if (payloadBytes > MAX_ARCHIVE_BYTES) throw new Error('The device archive exceeds 256 MB. No data was imported or deleted.')
    records.push(envelope)
  }
  const wrapped = (value: unknown) => ({ origin: 'legacy-device', value: evidence(value) })
  await add('project', id, { id, title: project.title, mode: project.mode, language: project.language,
    activityId: project.activityId ?? null, status: project.status, createdAt: timestamp(project.createdAt), updatedAt: timestamp(project.updatedAt) })
  await add('capture-status', 'legacy-project', wrapped(snapshot.project))
  for (const [index, raw] of snapshot.files.entries()) {
    const file = object.parse(raw)
    if (file.projectId !== project.id) throw new Error('A saved file belongs to another device project.')
    const { content, ...metadata } = file
    await add('source', z.string().parse(file.path), { path: file.path, content, revision: file.revision ?? 1, deleted: false, updatedAt: timestamp(file.updatedAt) })
    await add('capture-status', `legacy-file:${index}`, wrapped(metadata))
  }
  let messageCount = 0
  if (snapshot.chat !== undefined) {
    const chat = z.object({ projectId: z.literal(project.id), messages: z.array(z.unknown()).max(49_000) }).passthrough().parse(snapshot.chat)
    const { messages, ...metadata } = chat
    await add('capture-status', 'legacy-chat', wrapped(metadata))
    for (const [index, message] of messages.entries()) await add('message', `legacy:${String(index).padStart(8, '0')}`, wrapped(message))
    messageCount = messages.length
  }
  for (const [index, attempt] of snapshot.attempts.entries()) {
    if (object.parse(attempt).projectId !== project.id) throw new Error('An attempt belongs to another device project.')
    await add('assessment', `legacy-attempt:${index}`, { ...wrapped(attempt), store: 'attempts' })
  }
  for (const [index, progress] of snapshot.progress.entries()) await add('assessment', `legacy-progress:${index}`, { ...wrapped(progress), store: 'progress', sharedActivitySummary: true })
  for (const [index, activity] of snapshot.generatedActivities.entries()) await add('activity', `legacy-activity:${index}`, wrapped(activity))
  if (snapshot.portfolio !== undefined) await add('portfolio-project', 'legacy-portfolio', wrapped(snapshot.portfolio))
  const digest = await textDigest(records.map(record => archiveDigestLine(record, 3)).join(''))
  // Stable IDs/timestamps allow re-preparing unchanged local data to resume a
  // staged import. If source changes, use the downloaded original backup.
  const manifest = archiveManifestSchema.parse({ format: 'codetutor-project-archive', version: 3, scope: 'saved-project',
    includesUnsavedDrafts: false, includesLiveSandboxFiles: false, id: hashId(digest), projectId: id,
    createdAt: timestamp(project.updatedAt), expiresAt: timestamp(project.updatedAt), recordCount: records.length, payloadBytes })
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value) + '\n')
  const blob = new Blob([encode(manifest), ...records.map(encode), encode({ complete: true, id: manifest.id, recordCount: records.length, payloadBytes })], { type: 'application/x-ndjson' })
  const verified = await inspectArchive(blob, signal)
  return { blob, manifest, digest, title: project.title, fileCount: verified.fileCount, messageCount, attemptCount: snapshot.attempts.length }
}

export type LegacyArchive = Awaited<ReturnType<typeof legacySnapshotArchive>>
export function prepareLegacyArchive(projectId: string, signal: AbortSignal) {
  return readWithDeadline(async deadline => legacySnapshotArchive(await readLegacyProject(projectId, deadline), deadline),
    signal, 60_000, 'Preparing the device backup timed out. The original data is unchanged.')
}
