import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { applySandboxSource, SOURCE_APPLY_PROGRAM, type AppliedSourceFile } from '@/lib/sandbox/source-apply'

const execute = promisify(execFile)
const file = (revision: number, content = `revision ${revision}`): AppliedSourceFile => ({ path: 'src/main.ts', content, revision })
let directory: string
let workspace: string
let state: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'codetutor-source-test-'))
  workspace = join(directory, 'workspace')
  state = join(directory, 'state')
  await mkdir(workspace)
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }); vi.restoreAllMocks() })

// Test the same program, with only filesystem roots/owner injected into its
// pure apply function. The production entry point accepts no such overrides.
async function apply(files: AppliedSourceFile[], interrupt = false) {
  const input = join(directory, `${randomUUID()}.json`)
  await writeFile(input, JSON.stringify(files))
  const runner = `
scope = {'__name__': 'test'}
exec(${JSON.stringify(SOURCE_APPLY_PROGRAM)}, scope)
import json, os, sys
if sys.argv[4] == 'interrupt':
    original = scope['atomic_write']
    def interrupted(parent, name, *args):
        if name == 'main.ts': raise scope['ApplyFailure']('TEST_INTERRUPTED')
        return original(parent, name, *args)
    scope['atomic_write'] = interrupted
try:
    with open(sys.argv[1]) as stream: files = json.load(stream)
    print(json.dumps({'applied': scope['apply'](files, sys.argv[2], sys.argv[3], os.getuid())}))
except scope['ApplyFailure'] as error: print(json.dumps({'error': error.code}))
except OSError as error: print(json.dumps({'error': 'OS_ERROR', 'errno': error.errno}))
`
  const { stdout } = await execute('python3', ['-I', '-S', '-c', runner, input, workspace, state, interrupt ? 'interrupt' : 'normal'], { timeout: 10_000, maxBuffer: 1024 * 1024 })
  return JSON.parse(stdout) as { applied?: Array<{ path: string; revision: number }>; error?: string }
}

describe('sandbox-side source fencing (real filesystem/processes)', () => {
  it('rejects an older write that arrives after a newer one', async () => {
    expect(await apply([file(2)])).toEqual({ applied: [{ path: 'src/main.ts', revision: 2 }] })
    expect(await apply([file(1)])).toEqual({ error: 'SOURCE_SUPERSEDED' })
    expect(await readFile(join(workspace, 'src/main.ts'), 'utf8')).toBe('revision 2')
  })

  it('serializes concurrent writers without ever lowering the revision', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, (_, index) => apply([file(index + 1)])))
    expect(results, JSON.stringify(results)).toSatisfy((values: typeof results) => values.every((result) => result.applied || result.error === 'SOURCE_SUPERSEDED'))
    expect(await readFile(join(workspace, 'src/main.ts'), 'utf8')).toBe('revision 10')
  })

  it('fences older writes even when interrupted between journal and file application', async () => {
    await apply([file(1)])
    expect(await apply([file(3)], true)).toEqual({ error: 'TEST_INTERRUPTED' })
    expect(await readFile(join(workspace, 'src/main.ts'), 'utf8')).toBe('revision 1')
    expect(await apply([file(2)])).toEqual({ error: 'SOURCE_SUPERSEDED' })
    expect((await apply([file(3)])).error).toBeUndefined()
    expect(await readFile(join(workspace, 'src/main.ts'), 'utf8')).toBe('revision 3')
  })

  it('allows an idempotent repair but rejects different contents for the same revision', async () => {
    await apply([file(3)])
    expect((await apply([file(3)])).error).toBeUndefined()
    expect(await apply([file(3, 'different')])).toEqual({ error: 'SOURCE_REVISION_MISMATCH' })
    expect(await readFile(join(workspace, 'src/main.ts'), 'utf8')).toBe('revision 3')
  })

  it('prevalidates every revision before changing any file in the batch', async () => {
    await apply([file(3)])
    expect(await apply([{ path: 'new.ts', content: 'new', revision: 1 }, file(2)])).toEqual({ error: 'SOURCE_SUPERSEDED' })
    await expect(stat(join(workspace, 'new.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses symlink parents and targets without touching their destinations', async () => {
    const outside = join(directory, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'main.ts'), 'untouched')
    await symlink(outside, join(workspace, 'src'))
    expect((await apply([file(1)])).error).toBeTruthy()
    expect(await readFile(join(outside, 'main.ts'), 'utf8')).toBe('untouched')
    await symlink(join(outside, 'main.ts'), join(workspace, 'target.ts'))
    expect(await apply([{ path: 'target.ts', content: 'blocked', revision: 1 }])).toEqual({ error: 'SOURCE_PATH_UNSAFE' })
    expect(await readFile(join(outside, 'main.ts'), 'utf8')).toBe('untouched')
  })

  it('preserves executable permission without setting privileged bits', async () => {
    await apply([{ path: 'run.sh', content: 'old', revision: 1 }])
    await chmod(join(workspace, 'run.sh'), 0o755)
    expect((await apply([{ path: 'run.sh', content: '#!/bin/sh\necho ok', revision: 2 }])).error).toBeUndefined()
    expect((await stat(join(workspace, 'run.sh'))).mode & 0o7777).toBe(0o755)
  })

  it('does not overwrite terminal edits with either a newer save or an idempotent retry', async () => {
    await apply([file(1)])
    await writeFile(join(workspace, 'src/main.ts'), 'terminal edits')
    expect(await apply([file(2)])).toEqual({ error: 'SOURCE_WORKSPACE_CHANGED' })
    expect(await apply([file(1)])).toEqual({ error: 'SOURCE_WORKSPACE_CHANGED' })
    expect(await readFile(join(workspace, 'src/main.ts'), 'utf8')).toBe('terminal edits')
  })

  it('does not resurrect a file deleted in the terminal', async () => {
    await apply([file(1)])
    await unlink(join(workspace, 'src/main.ts'))
    expect(await apply([file(2)])).toEqual({ error: 'SOURCE_WORKSPACE_CHANGED' })
    await expect(stat(join(workspace, 'src/main.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not replace an untracked terminal file, but can acknowledge identical content', async () => {
    await mkdir(join(workspace, 'src'))
    await writeFile(join(workspace, 'src/main.ts'), 'terminal edits')
    expect(await apply([file(1)])).toEqual({ error: 'SOURCE_WORKSPACE_CHANGED' })
    expect(await apply([file(1, 'terminal edits')])).toEqual({ applied: [{ path: 'src/main.ts', revision: 1 }] })
  })

  it('records confirmed application separately from a pending reserved revision', async () => {
    await apply([file(1)])
    await apply([file(3)], true)
    const record = JSON.parse(await readFile(join(state, `${createHash('sha256').update('src/main.ts').digest('hex')}.json`), 'utf8'))
    expect(record).toMatchObject({ path: 'src/main.ts', revision: 3, appliedRevision: 1, appliedDigest: createHash('sha256').update('revision 1').digest('hex') })
    await apply([file(3)])
    const applied = JSON.parse(await readFile(join(state, `${createHash('sha256').update('src/main.ts').digest('hex')}.json`), 'utf8'))
    expect(applied.appliedRevision).toBe(3)
    expect(applied.appliedDigest).toBe(applied.digest)
  })

  it.each(['../escape', '/absolute', 'a//b', 'a/./b', 'a\\b', 'a\0b'])('rejects unsafe path %s', async (path) => {
    expect((await apply([{ path, content: 'blocked', revision: 1 }])).error).toBe('SOURCE_PATH_UNSAFE')
  })

  it('rejects oversized UTF-8 source before creating any source file', async () => {
    expect(await apply([file(1, '🙂'.repeat(65_537))])).toEqual({ error: 'INVALID_SOURCE' })
  })
})

describe('trusted sandbox source transport', () => {
  it('uploads source as data and executes only the fixed isolated program', async () => {
    const files = [file(1, '__import__("os").system("false")')]
    const runCommand = vi.fn(async () => ({ exitCode: 0, stdout: async () => JSON.stringify({ applied: [{ path: files[0].path, revision: 1 }] }) }))
    const writeFiles = vi.fn(async () => undefined)
    await applySandboxSource({ runCommand, writeFiles, cwd: '/vercel' } as never, files)
    const uploaded = (writeFiles.mock.calls as unknown as [Array<{ path: string; content: Buffer; mode: number }>][])[0][0][0]
    expect(JSON.parse(uploaded.content.toString())).toEqual(files)
    expect(uploaded.mode).toBe(0o600)
    expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({ cmd: '/usr/bin/python3', cwd: '/', sudo: true, timeoutMs: 10_000,
      args: ['-I', '-S', '-c', SOURCE_APPLY_PROGRAM, uploaded.path, createHash('sha256').update(uploaded.content).digest('hex'), '/vercel'] }))
  })

  it('rejects mismatched acknowledgments and cleans only its staging file', async () => {
    const runCommand = vi.fn().mockResolvedValueOnce({ exitCode: 0, stdout: async () => JSON.stringify({ applied: [{ path: 'other.ts', revision: 1 }] }) }).mockResolvedValueOnce({ exitCode: 0 })
    const writeFiles = vi.fn(async () => undefined)
    await expect(applySandboxSource({ runCommand, writeFiles, cwd: '/vercel' } as never, [file(1)])).rejects.toMatchObject({ code: 'SOURCE_RECEIPT_INVALID' })
    const stage = (writeFiles.mock.calls as unknown as [Array<{ path: string }>][])[0][0][0].path
    expect(runCommand.mock.calls[1][0]).toMatchObject({ cmd: '/usr/bin/rm', args: ['-f', '--', stage], sudo: false })
  })

  it('redacts unexpected SDK failures and uses a separate cleanup deadline', async () => {
    const runCommand = vi.fn().mockRejectedValueOnce(new Error('private provider detail')).mockResolvedValueOnce({ exitCode: 0 })
    await expect(applySandboxSource({ runCommand, writeFiles: vi.fn(), cwd: '/vercel' } as never, [file(1)])).rejects.toMatchObject({ message: 'SOURCE_APPLY_FAILED' })
    expect(runCommand.mock.calls[1][0].signal).not.toBe(runCommand.mock.calls[0][0].signal)
    expect(runCommand.mock.calls[1][0].signal.aborted).toBe(false)
  })
})
