import { expect, it } from 'vitest'
import { archiveDigestLine } from '@/lib/projects/archive'
import { inspectArchive, readArchive } from '@/lib/projects/archive-import'
import { archiveFixture, combinedArchive, projectRecord, repackArchive, sourceRecord } from './fixtures/project-archive'

const signal = () => new AbortController().signal
it('carries three recoveries in one flat archive with unchanged original history bytes', async () => {
  const original = await archiveFixture()
  let next = original
  for (let generation = 1; generation <= 3; generation++) {
    next = await combinedArchive(next, [projectRecord, { ...sourceRecord, data: { ...sourceRecord.data, content: 'latest' } }])
    expect(await inspectArchive(next.blob, signal())).toMatchObject({ digest: next.digest, fileCount: 1, sourceBytes: 6 })
    expect(next.envelopes.filter(item => JSON.parse(item.record).kind === 'archive-section')).toHaveLength(generation)
    expect(next.envelopes).toHaveLength(original.envelopes.length + 3 * generation)
    for (const item of original.envelopes) expect(next.envelopes.filter(candidate => candidate.sectionId === original.manifest.id && candidate.record === item.record)).toHaveLength(1)
  }
  const reread = []
  for await (const item of readArchive(next.blob, signal())) if (item.type === 'record') reread.push(item.envelope)
  expect(reread).toEqual(next.envelopes)
})
it('keeps historical paths separate from current-source recovery, including deleted files', async () => {
  const previous = await archiveFixture()
  const current = await combinedArchive(previous, [projectRecord,
    { ...sourceRecord, data: { ...sourceRecord.data, content: '', deleted: true } },
    { ...sourceRecord, key: 'main.ts/child.ts', data: { ...sourceRecord.data, path: 'main.ts/child.ts', content: 'new file' } },
  ])
  expect(await inspectArchive(current.blob, signal())).toMatchObject({ fileCount: 1, sourceBytes: 8 })
})
it('preserves large escaped historical records without recursive JSON growth', async () => {
  const original = await archiveFixture([projectRecord, { kind: 'message', key: 'large', data: { text: '"'.repeat(900_000) } }])
  const next = await combinedArchive(await combinedArchive(original))
  await expect(inspectArchive(next.blob, signal())).resolves.toMatchObject({ digest: next.digest })
  const record = next.envelopes.find(item => item.sectionId === original.manifest.id && JSON.parse(item.record).kind === 'message')
  expect(record?.record).toBe(original.envelopes[1].record)
})
it.each(['missing section', 'missing project', 'wrong position', 'wrong identity', 'root after history', 'duplicate section', 'duplicate record', 'wrong section totals', 'wrong section digest', 'nested section', 'uppercase section', 'own id', 'v2 section'])('rejects %s even if payload hashes and archive totals are recomputed', async mutation => {
  const original = await archiveFixture()
  const current = await combinedArchive(original)
  const envelopes = structuredClone(current.envelopes)
  const markerIndex = 2
  const marker = JSON.parse(envelopes[markerIndex].record)
  if (mutation === 'missing section') envelopes.splice(markerIndex, 1)
  if (mutation === 'missing project') envelopes.splice(markerIndex + 1, 1)
  if (mutation === 'wrong position') envelopes[markerIndex + 2].sectionIndex = 7
  if (mutation === 'wrong identity') marker.data.manifest.projectId = crypto.randomUUID()
  if (mutation === 'root after history') envelopes.push(current.envelopes[1])
  if (mutation === 'duplicate section') envelopes.push(...current.envelopes.slice(markerIndex))
  if (mutation === 'duplicate record') envelopes.push({ ...envelopes.at(-1)!, sectionIndex: original.envelopes.length + 1 })
  if (mutation === 'wrong section totals') marker.data.rootPayloadBytes++
  if (mutation === 'wrong section digest') { marker.data.rootDigest = '0'.repeat(64); marker.data.digest = marker.data.rootDigest }
  if (mutation === 'nested section') { envelopes[markerIndex].sectionId = original.manifest.id; envelopes[markerIndex].sectionIndex = 2 }
  if (mutation === 'uppercase section') envelopes[markerIndex + 1].sectionId = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'
  if (mutation === 'own id') { marker.key = current.manifest.id; marker.data.manifest.id = current.manifest.id }
  if (['wrong identity', 'wrong section totals', 'wrong section digest', 'own id'].includes(mutation)) envelopes[markerIndex].record = JSON.stringify(marker)
  const bad = await repackArchive({ ...current.manifest, version: mutation === 'v2 section' ? 2 : 3 }, envelopes)
  await expect(inspectArchive(bad.blob, signal())).rejects.toThrow()
})
it('rejects an empty final section and binds section identity/order into the v3 digest', async () => {
  const current = await combinedArchive(await archiveFixture())
  const empty = await repackArchive(current.manifest, current.envelopes.slice(0, 3))
  await expect(inspectArchive(empty.blob, signal())).rejects.toThrow()
  const record = current.envelopes[3]
  expect(archiveDigestLine(record, 3)).not.toBe(archiveDigestLine({ ...record, sectionIndex: 2 }, 3))
  expect(archiveDigestLine(record, 3)).not.toBe(archiveDigestLine({ ...record, sectionId: crypto.randomUUID() }, 3))
})
it('can carry a legacy manifest whose archive UUID uses uppercase letters', async () => {
  const original = await archiveFixture()
  const upper = await repackArchive({ ...original.manifest, id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }, original.envelopes)
  const combined = await combinedArchive(upper)
  expect(await inspectArchive(combined.blob, signal())).toMatchObject({ digest: combined.digest })
})
