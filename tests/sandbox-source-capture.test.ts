import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { captureSandboxSource, SOURCE_CAPTURE_PROGRAM, sourceCaptureSchema } from '@/lib/sandbox/source-capture'

const execute = promisify(execFile)
const hash = (content: string | Buffer) => createHash('sha256').update(content).digest('hex')
let directory: string
let workspace: string
let state: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'codetutor-capture-test-'))
  workspace = join(directory, 'workspace')
  state = join(directory, 'state')
  await mkdir(workspace)
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }); vi.restoreAllMocks() })

async function run(expression: string, input: unknown = []) {
  const staged = join(directory, `${randomUUID()}.json`)
  await writeFile(staged, JSON.stringify(input))
  const program = `scope = {'__name__':'test'}\nexec(${JSON.stringify(SOURCE_CAPTURE_PROGRAM)}, scope)\nimport json, os, sys\nwith open(sys.argv[1]) as stream: data = json.load(stream)\ntry:\n    result = ${expression}\n    print(json.dumps(result, ensure_ascii=True))\nexcept scope['ApplyFailure'] as error: print(json.dumps({'error': error.code}))`
  const { stdout } = await execute('python3', ['-I', '-S', '-c', program, staged, workspace, state], { timeout: 10_000, maxBuffer: 64 * 1024 * 1024 })
  return JSON.parse(stdout)
}
const scan = (paths: string[] = []) => run("scope['capture'](sys.argv[2], data, sys.argv[3], os.getuid())", paths)
const apply = (revision: number, content = 'saved') => run("scope['apply'](data, sys.argv[2], sys.argv[3], os.getuid())", [{ path: 'main.ts', content, revision }])

describe('protected source capture (actual Python reader)', () => {
  it('captures terminal edits with the confirmed baseline and discovers terminal-created files', async () => {
    await apply(1)
    await writeFile(join(workspace, 'main.ts'), 'terminal edit')
    await writeFile(join(workspace, 'new.py'), 'print(42)')
    const capture = sourceCaptureSchema.parse(await scan())
    expect(capture.complete).toBe(true)
    expect(capture.entries).toMatchObject([
      { path: 'main.ts', kind: 'file', content: 'terminal edit', digest: hash('terminal edit'), baseRevision: 1, baseDigest: hash('saved'), pending: false },
      { path: 'new.py', kind: 'file', baseRevision: 0, baseDigest: null, pending: false },
    ])
  })

  it('discovers deleted files from the protected journal without a browser path list', async () => {
    await apply(2)
    await unlink(join(workspace, 'main.ts'))
    expect((await scan()).entries).toEqual([{ path: 'main.ts', kind: 'missing', baseRevision: 2, baseDigest: hash('saved'), pending: false }])
  })

  it('never labels an interrupted reservation as the applied source revision', async () => {
    await apply(1)
    const key = join(state, `${hash('main.ts')}.json`)
    const record = JSON.parse(await readFile(key, 'utf8'))
    await writeFile(key, JSON.stringify({ ...record, revision: 3, digest: hash('newer') }))
    const result = sourceCaptureSchema.parse(await scan())
    expect(result.complete).toBe(false)
    expect(result.entries[0]).toMatchObject({ kind: 'file', content: 'saved', baseRevision: 1, pending: true })
    await writeFile(join(workspace, 'main.ts'), 'newer')
    expect(sourceCaptureSchema.parse(await scan()).entries[0]).toMatchObject({ kind: 'file', baseRevision: 3, pending: false })
  })

  it('marks legacy journals uncertain unless their bytes prove application', async () => {
    await apply(1)
    await writeFile(join(state, `${hash('main.ts')}.json`), JSON.stringify({ revision: 1, digest: hash('saved') }))
    expect((await scan(['main.ts'])).entries[0]).toMatchObject({ baseRevision: 1, pending: false })
    await writeFile(join(workspace, 'main.ts'), 'terminal edit')
    const result = sourceCaptureSchema.parse(await scan(['main.ts']))
    expect(result.complete).toBe(false)
    expect(result.entries[0]).toMatchObject({ content: 'terminal edit', baseRevision: null, pending: true })
  })

  it('excludes secrets, dependencies, caches, binary extensions and internal artifacts', async () => {
    for (const path of ['.env', '.env.local', '.ssh/id_rsa', '.aws/credentials', '.config/token', 'node_modules/pkg/index.js', '.next/server.js', 'dist/app.js', '.git/config', 'photo.png', '.codetutor-write-fixture']) {
      await mkdir(join(workspace, path, '..'), { recursive: true })
      await writeFile(join(workspace, path), 'must not be captured')
    }
    await writeFile(join(workspace, '.env.example'), 'TOKEN=')
    const result = sourceCaptureSchema.parse(await scan())
    expect(result.complete).toBe(true)
    expect(result.entries.map((entry) => entry.path)).toEqual(['.env.example'])
    expect(result.excluded).toBe(11)
  })

  it('does not read symlinks, hard links, FIFOs or symlinked parent directories', async () => {
    const outside = join(directory, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'private.ts'), 'private sentinel')
    await symlink(outside, join(workspace, 'linked'))
    await symlink(join(outside, 'private.ts'), join(workspace, 'alias.ts'))
    await link(join(outside, 'private.ts'), join(workspace, 'hard.ts'))
    await execute('mkfifo', [join(workspace, 'pipe')])
    const result = sourceCaptureSchema.parse(await scan(['linked/private.ts']))
    expect(result.complete).toBe(false)
    expect(result.entries).toHaveLength(5)
    expect(result.entries.every((entry) => entry.kind === 'skipped' && entry.reason === 'unsafe')).toBe(true)
    expect(JSON.stringify(result)).not.toContain('private sentinel')
  })

  it('excludes the live image tool-home files and credential configuration', async () => {
    for (const path of ['.codex/auth.json', '.local/state/gh/device-id', '.npm/_logs/debug.log', '.npmrc',
      '.netrc', '.git-credentials', '.pypirc', '.bash_history', '.sudo_as_admin_successful', '.venv/lib/package.py']) {
      await mkdir(join(workspace, path, '..'), { recursive: true })
      await writeFile(join(workspace, path), 'sensitive runtime sentinel')
    }
    await symlink('/tmp', join(workspace, '.codex', 'apply_patch'))
    await writeFile(join(workspace, 'main.ts'), 'source')
    const result = sourceCaptureSchema.parse(await scan())
    expect(result.complete).toBe(true)
    expect(result.entries.map((entry) => entry.path)).toEqual(['main.ts'])
    expect(JSON.stringify(result)).not.toContain('sensitive runtime sentinel')
  })

  it('ignores runtime paths in older protected journals without reading their contents', async () => {
    await apply(1)
    await writeFile(join(workspace, '.npmrc'), 'runtime credential sentinel')
    await writeFile(join(state, `${hash('.npmrc')}.json`), JSON.stringify({ path: '.npmrc', revision: 1,
      digest: hash('old config'), appliedRevision: 1, appliedDigest: hash('old config') }))
    const result = sourceCaptureSchema.parse(await scan())
    expect(result.complete).toBe(true)
    expect(result.entries.map((entry) => entry.path)).toEqual(['main.ts'])
  })

  it('reports oversized and binary-looking source as skipped, not missing or successfully captured', async () => {
    await writeFile(join(workspace, 'nul.ts'), 'before\0after')
    await writeFile(join(workspace, 'invalid.ts'), Buffer.from([0xff, 0xfe]))
    await writeFile(join(workspace, 'large.ts'), 'a'.repeat(262145))
    const result = sourceCaptureSchema.parse(await scan())
    expect(result.complete).toBe(false)
    expect(result.entries).toMatchObject([
      { path: 'invalid.ts', kind: 'skipped', reason: 'binary' },
      { path: 'large.ts', kind: 'skipped', reason: 'too-large' },
      { path: 'nul.ts', kind: 'skipped', reason: 'binary' },
    ])
  })

  it('fails explicitly rather than returning a truncated project over 200 source files', async () => {
    await Promise.all(Array.from({ length: 201 }, (_, index) => writeFile(join(workspace, `${index}.ts`), 'x')))
    expect(await scan()).toEqual({ error: 'SOURCE_SCAN_LIMIT' })
  })

  it('fails explicitly over 10 MB of otherwise valid source files', async () => {
    await Promise.all(Array.from({ length: 41 }, (_, index) => writeFile(join(workspace, `${index}.ts`), 'x'.repeat(262144))))
    expect(await scan()).toEqual({ error: 'SOURCE_SCAN_LIMIT' })
  })

  it('captures maximum-sized Unicode files byte-exactly and handles ordinary prototype-like names', async () => {
    const content = '🙂'.repeat(65536)
    await mkdir(join(workspace, '__proto__'))
    await writeFile(join(workspace, '__proto__/你好.ts'), content)
    const result = sourceCaptureSchema.parse(await scan())
    expect(result.entries[0]).toMatchObject({ path: '__proto__/你好.ts', content, digest: hash(content) })
    expect(result.totalBytes).toBe(262144)
  })

  it('does not mistake directory extensions for binary files', async () => {
    await mkdir(join(workspace, 'assets.png'))
    await writeFile(join(workspace, 'assets.png/index.ts'), 'source')
    expect(sourceCaptureSchema.parse(await scan()).entries[0]).toMatchObject({ path: 'assets.png/index.ts', kind: 'file', content: 'source' })
  })

  it('refuses a journal exposed to the learner', async () => {
    await apply(1)
    await chmod(state, 0o777)
    expect(await scan()).toEqual({ error: 'SOURCE_JOURNAL_INVALID' })
  })
})

describe('capture transport integrity', () => {
  const result = { entries: [{ path: 'main.ts', kind: 'file', content: 'test', digest: hash('test'), baseRevision: 0, baseDigest: null, pending: false }], complete: true, totalBytes: 4, excluded: 0 }
  function vm(body = JSON.stringify(result)) {
    const content = Buffer.from(body)
    return {
      cwd: '/vercel', writeFiles: vi.fn(async () => undefined),
      runCommand: vi.fn(async () => ({ exitCode: 0, stdout: async () => JSON.stringify({ bytes: content.length, digest: hash(content) }) })),
      readFile: vi.fn(async () => (async function* () { yield content.subarray(0, 5); yield content.subarray(5) })()),
    }
  }
  it('reads a digest-verified artifact, not source text from command output, and always cleans its own artifacts', async () => {
    const sandbox = vm()
    expect(await captureSandboxSource(sandbox as never, ['main.ts'])).toEqual(result)
    const command = (sandbox.runCommand.mock.calls as unknown as [Record<string, unknown>][])[0][0]
    expect(command).toMatchObject({ cmd: '/usr/bin/python3', cwd: '/', sudo: true, timeoutMs: 10000 })
    expect(command.args).toContain(SOURCE_CAPTURE_PROGRAM)
    expect(sandbox.runCommand.mock.calls.at(-1)).toMatchObject([{ cmd: '/usr/bin/rm', sudo: true }])
  })

  it('rejects changed artifact bytes even if the length matches', async () => {
    const sandbox = vm()
    sandbox.readFile.mockImplementation(async () => (async function* () { yield Buffer.from(JSON.stringify(result).replace('test', 'evil')) })())
    await expect(captureSandboxSource(sandbox as never, [])).rejects.toMatchObject({ code: 'SOURCE_CAPTURE_CHANGED' })
    expect(sandbox.runCommand).toHaveBeenCalledTimes(2)
  })

  it('rejects inconsistent or duplicated capture entries', async () => {
    const sandbox = vm(JSON.stringify({ ...result, entries: [...result.entries, ...result.entries] }))
    await expect(captureSandboxSource(sandbox as never, [])).rejects.toMatchObject({ code: 'SOURCE_CAPTURE_FAILED' })
  })

  it('aborts a stalled artifact read and uses a separate bounded cleanup signal', async () => {
    const controller = new AbortController()
    const sandbox = vm()
    sandbox.readFile.mockImplementation(async () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}), return: async () => ({ done: true }) }) }) as never)
    const pending = captureSandboxSource(sandbox as never, [], controller.signal)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(sandbox.readFile).toHaveBeenCalled())
    controller.abort()
    await rejected
    const cleanup = (sandbox.runCommand.mock.calls as unknown as [Record<string, unknown>][]).at(-1)![0]
    expect((cleanup.signal as AbortSignal).aborted).toBe(false)
  })
})
