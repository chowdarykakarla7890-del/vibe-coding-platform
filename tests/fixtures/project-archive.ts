import { archiveDigestLine, originalArchiveKinds, type ArchiveEnvelope, type ArchiveManifest } from '@/lib/projects/archive'
import { archiveManifestSchema } from '@/lib/projects/archive-import'
import { textDigest } from '@/lib/projects/source-import'

export const originalProjectId = '11111111-1111-4111-8111-111111111111'
export const date = '2026-08-01T00:00:00.000Z'
export const projectRecord = { kind: 'project', key: originalProjectId, data: {
  id: originalProjectId, title: 'Archive fixture', mode: 'practice', status: 'completed', activityId: 'unverified-activity',
  language: 'TypeScript', createdAt: date, updatedAt: date,
} }
export const sourceRecord = { kind: 'source', key: 'main.ts', data: { path: 'main.ts', content: 'saved 😀', revision: 8, deleted: false, updatedAt: date } }
export const allRecords = [projectRecord, sourceRecord, ...originalArchiveKinds.filter(kind => kind !== 'project' && kind !== 'source').map(kind => ({
  kind, key: `original-${kind}`, data: { evidence: 'retain unchanged', score: 100, sandboxId: 'never-authorize', parts: [{ type: 'tool-runCommand', state: 'output-available', output: 'never-replay' }] },
}))]
export async function archiveFixture(records: unknown[] = allRecords) {
  const envelopes: ArchiveEnvelope[] = await Promise.all(records.map(async (value, index) => {
    const record = JSON.stringify(value)
    return { index: index + 1, record, sha256: await textDigest(record) }
  }))
  const manifest = archiveManifestSchema.parse({
    format: 'codetutor-project-archive', version: 2, scope: 'saved-project', includesUnsavedDrafts: false, includesLiveSandboxFiles: false,
    id: '22222222-2222-4222-8222-222222222222', projectId: originalProjectId, createdAt: date, expiresAt: date,
    recordCount: envelopes.length, payloadBytes: envelopes.reduce((sum, value) => sum + new TextEncoder().encode(value.record).length, 0),
  })
  const end = { complete: true, id: manifest.id, recordCount: manifest.recordCount, payloadBytes: manifest.payloadBytes }
  const lines = [manifest, ...envelopes, end]
  const blob = new Blob([lines.map(value => JSON.stringify(value) + '\n').join('')])
  return { blob, manifest, envelopes, end, lines, digest: await textDigest(envelopes.map(value => `${value.index}:${value.sha256}\n`).join('')) }
}
export function archiveBlob(lines: unknown[]) { return new Blob([lines.map(value => JSON.stringify(value) + '\n').join('')]) }

export async function repackArchive(manifest: ArchiveManifest, records: ArchiveEnvelope[]) {
  const envelopes = await Promise.all(records.map(async (record, index) => ({ ...record, index: index + 1, sha256: await textDigest(record.record) })))
  manifest = { ...manifest, recordCount: envelopes.length, payloadBytes: envelopes.reduce((sum, item) => sum + new TextEncoder().encode(item.record).byteLength, 0) }
  const end = { complete: true, id: manifest.id, recordCount: manifest.recordCount, payloadBytes: manifest.payloadBytes }
  const lines = [manifest, ...envelopes, end]
  return { manifest, envelopes, end, lines, blob: archiveBlob(lines), digest: await textDigest(envelopes.map(item => archiveDigestLine(item, manifest.version)).join('')) }
}

/** Model a re-export independently of the database implementation. */
export async function combinedArchive(previous: Awaited<ReturnType<typeof archiveFixture>>, currentRecords: unknown[] = [projectRecord, sourceRecord]) {
  const current = await archiveFixture(currentRecords)
  const root = previous.envelopes.filter(item => !item.sectionId && JSON.parse(item.record).kind !== 'archive-section')
  const record = JSON.stringify({ kind: 'archive-section', key: previous.manifest.id.toLowerCase(), data: {
    manifest: previous.manifest, digest: previous.digest, rootRecordCount: root.length,
    rootPayloadBytes: root.reduce((sum, item) => sum + new TextEncoder().encode(item.record).byteLength, 0),
    rootDigest: await textDigest(root.map(item => archiveDigestLine(item, 2)).join('')),
  } })
  const history = previous.envelopes.map(item => item.sectionId || JSON.parse(item.record).kind === 'archive-section' ? item :
    { ...item, sectionId: previous.manifest.id.toLowerCase(), sectionIndex: item.index })
  return repackArchive({ ...current.manifest, id: crypto.randomUUID(), version: 3 },
    [...current.envelopes, { index: 1, record, sha256: await textDigest(record) }, ...history])
}
