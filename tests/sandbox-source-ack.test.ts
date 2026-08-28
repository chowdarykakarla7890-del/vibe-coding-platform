import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { acknowledgeSandboxCapture, SOURCE_ACK_PROGRAM } from '@/lib/sandbox/source-ack'
import { sourceCaptureSchema } from '@/lib/sandbox/source-capture'

const execute = promisify(execFile)
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
let directory: string
let workspace: string
let state: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'codetutor-ack-test-'))
  workspace = join(directory, 'workspace'); state = join(directory, 'state')
  await mkdir(workspace)
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }); vi.restoreAllMocks() })

async function run(method: 'apply' | 'capture' | 'acknowledge', input: unknown) {
  const stage = join(directory, `${randomUUID()}.json`)
  await writeFile(stage, JSON.stringify(input))
  const expression = method === 'capture' ? "scope['capture'](sys.argv[2], data, sys.argv[3], os.getuid())" : `scope[${JSON.stringify(method)}](data, sys.argv[2], sys.argv[3], os.getuid())`
  const program = `scope = {'__name__':'test'}\nexec(${JSON.stringify(SOURCE_ACK_PROGRAM)}, scope)\nimport json, os, sys\nwith open(sys.argv[1]) as stream: data = json.load(stream)\ntry:\n    result = ${expression}\n    print(json.dumps(result, ensure_ascii=True))\nexcept scope['ApplyFailure'] as error: print(json.dumps({'error': error.code}))`
  const { stdout } = await execute('python3', ['-I', '-S', '-c', program, stage, workspace, state], { timeout: 10_000, maxBuffer: 1024 * 1024 })
  return JSON.parse(stdout)
}
const apply = (revision = 1, content = 'saved') => run('apply', [{ path: 'main.ts', content, revision }])
const acknowledge = (revision: number, content: string | null) => run('acknowledge', [{ path: 'main.ts', revision, digest: content === null ? null : hash(content) }])
const journal = () => readFile(join(state, `${hash('main.ts')}.json`), 'utf8').then(JSON.parse)

describe('protected capture acknowledgment', () => {
  it('advances a captured edit baseline without writing source, and is idempotent', async () => {
    await apply()
    await writeFile(join(workspace, 'main.ts'), 'terminal edit')
    expect(await acknowledge(2, 'terminal edit')).toEqual([{ path: 'main.ts', revision: 2, digest: hash('terminal edit') }])
    expect((await run('capture', [])).entries[0]).toMatchObject({ content: 'terminal edit', baseRevision: 2, baseDigest: hash('terminal edit'), pending: false })
    expect(await acknowledge(2, 'terminal edit')).not.toHaveProperty('error')
    expect(await readFile(join(workspace, 'main.ts'), 'utf8')).toBe('terminal edit')
  })

  it('acknowledges deletion, fences old writers and retains the baseline on recreation', async () => {
    await apply()
    await unlink(join(workspace, 'main.ts'))
    expect(await acknowledge(2, null)).not.toHaveProperty('error')
    expect(sourceCaptureSchema.parse(await run('capture', ['main.ts'])).entries[0]).toMatchObject({ kind: 'missing', baseRevision: 2, baseDigest: null, pending: false })
    expect((await run('capture', [])).entries).toEqual([])
    expect(await apply(1)).toEqual({ error: 'SOURCE_SUPERSEDED' })
    await writeFile(join(workspace, 'main.ts'), 'terminal recreation')
    expect(sourceCaptureSchema.parse(await run('capture', [])).entries[0]).toMatchObject({ content: 'terminal recreation', baseRevision: 2, baseDigest: null, pending: false })
    expect(await acknowledge(3, 'terminal recreation')).not.toHaveProperty('error')
  })

  it('allows an explicit new saved file after confirmed deletion without resetting revisions', async () => {
    await apply()
    await unlink(join(workspace, 'main.ts'))
    await acknowledge(2, null)
    expect(await apply(3, 'new saved file')).toEqual([{ path: 'main.ts', revision: 3 }])
    expect((await run('capture', [])).entries[0]).toMatchObject({ content: 'new saved file', baseRevision: 3 })
  })

  it('never acknowledges bytes that changed after capture', async () => {
    await apply()
    await writeFile(join(workspace, 'main.ts'), 'later terminal edit')
    const before = await journal()
    expect(await acknowledge(2, 'captured earlier')).toEqual({ error: 'SOURCE_WORKSPACE_CHANGED' })
    expect(await journal()).toEqual(before)
    expect(await readFile(join(workspace, 'main.ts'), 'utf8')).toBe('later terminal edit')
    expect(await acknowledge(2, null)).toEqual({ error: 'SOURCE_WORKSPACE_CHANGED' })
  })

  it('rejects late and mismatched receipts without rolling back newer saved state', async () => {
    await apply(3, 'newer')
    expect(await acknowledge(2, 'newer')).toEqual({ error: 'SOURCE_SUPERSEDED' })
    expect(await acknowledge(3, 'different')).toEqual({ error: 'SOURCE_REVISION_MISMATCH' })
    expect((await journal()).revision).toBe(3)
  })

  it('checks every file before updating any journal in a batch', async () => {
    await apply()
    const before = await journal()
    expect(await run('acknowledge', [{ path: 'main.ts', revision: 2, digest: hash('saved') }, { path: 'missing.ts', revision: 1, digest: hash('not there') }])).toEqual({ error: 'SOURCE_WORKSPACE_CHANGED' })
    expect(await journal()).toEqual(before)
  })

  it('captures a file-to-directory replacement as a deletion plus the new child', async () => {
    await apply()
    await unlink(join(workspace, 'main.ts'))
    await mkdir(join(workspace, 'main.ts'))
    await writeFile(join(workspace, 'main.ts/child.ts'), 'child')
    const result = sourceCaptureSchema.parse(await run('capture', []))
    expect(result.complete).toBe(true)
    expect(result.entries).toMatchObject([{ path: 'main.ts', kind: 'missing', baseRevision: 1 }, { path: 'main.ts/child.ts', kind: 'file' }])
    expect(await acknowledge(2, null)).not.toHaveProperty('error')
    expect((await run('capture', [])).entries.map((entry: { path: string }) => entry.path)).toEqual(['main.ts/child.ts'])
  })

  it('does not let historical deletion markers exhaust source scan capacity', async () => {
    await run('acknowledge', Array.from({ length: 400 }, (_, index) => ({ path: `deleted-${index}.ts`, revision: 1, digest: null })))
    await acknowledge(1, null)
    await writeFile(join(workspace, 'live.ts'), 'current')
    expect((await run('capture', [])).entries).toMatchObject([{ path: 'live.ts', kind: 'file' }])
  })
})

describe('acknowledgment transport', () => {
  const receipts = [{ path: 'main.ts', revision: 2, digest: hash('edit') }]
  const vm = () => ({ cwd: '/vercel', writeFiles: vi.fn(async () => undefined), runCommand: vi.fn(async () => ({ exitCode: 0, stdout: async () => JSON.stringify({ acknowledged: receipts }) })) })
  it('validates exact receipts and cleans its staging artifact', async () => {
    const sandbox = vm()
    await acknowledgeSandboxCapture(sandbox as never, receipts)
    expect(sandbox.runCommand).toHaveBeenCalledTimes(2)
    expect(sandbox.runCommand.mock.calls[0]).toMatchObject([{ cmd: '/usr/bin/python3', cwd: '/', sudo: true }])
    expect(sandbox.runCommand.mock.calls[1]).toMatchObject([{ cmd: '/usr/bin/rm', sudo: true }])
  })
  it('rejects an acknowledgment for different bytes even if path and revision match', async () => {
    const sandbox = vm()
    sandbox.runCommand.mockResolvedValue({ exitCode: 0, stdout: async () => JSON.stringify({ acknowledged: [{ ...receipts[0], digest: hash('wrong') }] }) })
    await expect(acknowledgeSandboxCapture(sandbox as never, receipts)).rejects.toMatchObject({ code: 'SOURCE_RECEIPT_INVALID' })
    expect(sandbox.runCommand).toHaveBeenCalledTimes(2)
  })
})
