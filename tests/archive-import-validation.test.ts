import { expect, it } from 'vitest'
import { archiveBatchFits, inspectArchive, readArchive, validateImportedEnvelope } from '@/lib/projects/archive-import'
import { originalArchiveKinds } from '@/lib/projects/archive'
import { allRecords, archiveBlob, archiveFixture, projectRecord, sourceRecord } from './fixtures/project-archive'

const signal = () => new AbortController().signal
it('verifies every record kind and preserves the raw record bytes without executing imported tools', async () => {
  const fixture = await archiveFixture()
  expect(await inspectArchive(fixture.blob, signal())).toMatchObject({ manifest: fixture.manifest, digest: fixture.digest, fileCount: 1, sourceBytes: 10 })
  const records = []
  for await (const value of readArchive(fixture.blob, signal())) if (value.type === 'record') records.push(value.envelope)
  expect(records).toEqual(fixture.envelopes)
  expect(records.map(record => JSON.parse(record.record).kind)).toEqual([...originalArchiveKinds])
})
it.each(['missing end', 'extra after end', 'missing record', 'wrong order', 'corrupt hash', 'wrong byte count', 'wrong project'])('rejects %s before import', async kind => {
  const fixture = await archiveFixture()
  const lines = structuredClone(fixture.lines) as unknown[]
  if (kind === 'missing end') lines.pop()
  if (kind === 'extra after end') lines.push(fixture.envelopes[0])
  if (kind === 'missing record') lines.splice(2, 1)
  if (kind === 'wrong order') [lines[1], lines[2]] = [lines[2], lines[1]]
  if (kind === 'corrupt hash') lines[2] = { ...fixture.envelopes[1], sha256: '0'.repeat(64) }
  if (kind === 'wrong byte count') lines[0] = { ...fixture.manifest, payloadBytes: fixture.manifest.payloadBytes + 1 }
  if (kind === 'wrong project') lines[0] = { ...fixture.manifest, projectId: '33333333-3333-4333-8333-333333333333' }
  await expect(inspectArchive(archiveBlob(lines), signal())).rejects.toThrow()
})
it.each(['../escape', '.env', 'node_modules/main.ts', '.codetutor-private/main.ts', 'image.png'])('rejects unsafe source path %s', async path => {
  const fixture = await archiveFixture([projectRecord, { ...sourceRecord, key: path, data: { ...sourceRecord.data, path } }])
  await expect(inspectArchive(fixture.blob, signal())).rejects.toThrow()
})
it('rejects duplicate keys, source folder collisions and oversized source', async () => {
  for (const records of [
    [projectRecord, sourceRecord, sourceRecord],
    [projectRecord, sourceRecord, { ...sourceRecord, key: 'main.ts/child.ts', data: { ...sourceRecord.data, path: 'main.ts/child.ts' } }],
    [projectRecord, { ...sourceRecord, data: { ...sourceRecord.data, content: 'x'.repeat(262145) } }],
  ]) await expect(inspectArchive((await archiveFixture(records)).blob, signal())).rejects.toThrow()
})
it('retains deletion evidence without creating a live empty file', async () => {
  const fixture = await archiveFixture([projectRecord, { ...sourceRecord, data: { ...sourceRecord.data, deleted: true, content: '' } }])
  expect(await inspectArchive(fixture.blob, signal())).toMatchObject({ fileCount: 0, sourceBytes: 0 })
})
it('accepts exported 100-character project names and JSON-escaped source', async () => {
  const fixture = await archiveFixture([{ ...projectRecord, data: { ...projectRecord.data, title: 'a'.repeat(100) } }, { ...sourceRecord, data: { ...sourceRecord.data, content: '\u0001'.repeat(262144) } }])
  expect(await inspectArchive(fixture.blob, signal())).toMatchObject({ sourceBytes: 262144 })
  expect(archiveBatchFits(fixture.envelopes)).toBe(true)
})
it('rejects malformed UTF-8, null bytes, invalid Unicode and excessive nesting', async () => {
  await expect(inspectArchive(new Blob([new Uint8Array([255])]), signal())).rejects.toThrow()
  let nested: unknown = {}
  for (let i = 0; i < 35; i++) nested = { nested }
  for (const value of [nested, '\0', '\ud800']) {
    const fixture = await archiveFixture([projectRecord, { kind: 'message', key: 'm', data: { value } }])
    await expect(inspectArchive(fixture.blob, signal())).rejects.toThrow()
  }
})
it('aborts a stalled file reader and releases it', async () => {
  let cancelled = false
  const file = { size: 10, stream: () => new ReadableStream({ cancel: () => { cancelled = true } }) } as Blob
  const controller = new AbortController()
  const work = expect(inspectArchive(file, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort()
  await work
  expect(cancelled).toBe(true)
})
it('bounds batches by encoded bytes and count, not just raw payload bytes', async () => {
  const fixture = await archiveFixture([projectRecord, ...Array.from({ length: 20 }, (_, i) => ({ ...allRecords[2], key: String(i), data: { text: '"'.repeat(500_000) } }))])
  expect(archiveBatchFits(fixture.envelopes)).toBe(false)
  expect(archiveBatchFits([fixture.envelopes[1]])).toBe(true)
  expect(archiveBatchFits(fixture.envelopes.slice(1, 4))).toBe(false)
  await validateImportedEnvelope(fixture.envelopes[1])
})
