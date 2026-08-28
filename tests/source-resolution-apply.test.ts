import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applySandboxResolution, SOURCE_RESOLUTION_PROGRAM, type ResolvedSourceApplication } from '@/lib/sandbox/source-resolution-apply'

const execute = promisify(execFile)
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
let root: string, workspace: string, state: string, runtime: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'codetutor-resolution-'))
  workspace = join(root, 'workspace'); state = join(root, 'state'); runtime = join(root, 'runtime')
  await mkdir(workspace); await writeFile(join(workspace, 'main.ts'), 'captured')
})
afterEach(async () => { await rm(root, { recursive: true, force: true }); vi.restoreAllMocks() })
const item = (overrides: Partial<ResolvedSourceApplication> = {}): ResolvedSourceApplication => ({ path: 'main.ts', content: 'merged', revision: 2, expectedDigest: hash('captured'), ...overrides })

async function apply(input = item(), interrupt = false) {
  const stage = join(root, `${randomUUID()}.json`)
  await writeFile(stage, JSON.stringify(input))
  const program = `
scope = {'__name__': 'test'}
exec(${JSON.stringify(SOURCE_RESOLUTION_PROGRAM)}, scope)
import os,sys,json
if sys.argv[5] == 'interrupt':
    original = scope['atomic_write']
    def write(parent,name,*args):
        if name == 'main.ts': raise scope['ApplyFailure']('INTERRUPTED')
        return original(parent,name,*args)
    scope['atomic_write'] = write
    unlink = os.unlink
    def remove(name,*args,**kwargs):
        if name == 'main.ts': raise scope['ApplyFailure']('INTERRUPTED')
        return unlink(name,*args,**kwargs)
    os.unlink = remove
try:
    with open(sys.argv[1]) as stream: value=json.load(stream)
    print(json.dumps(scope['apply_resolution'](value,sys.argv[2],sys.argv[3],sys.argv[4],os.getuid())))
except scope['ApplyFailure'] as error: print(json.dumps({'error':error.code}))
except OSError: print(json.dumps({'error':'OS_ERROR'}))
`
  const result = await execute('python3', ['-I', '-S', '-c', program, stage, workspace, state, runtime, interrupt ? 'interrupt' : 'normal'], { timeout: 5000 })
  return JSON.parse(result.stdout)
}

describe('reviewed source application (real processes/filesystem)', () => {
  it('applies a reviewed merge and safely rechecks an identical receipt', async () => {
    expect(await apply()).toEqual({ path: 'main.ts', revision: 2, deleted: false })
    expect(await apply()).toEqual({ path: 'main.ts', revision: 2, deleted: false })
    expect(await readFile(join(workspace, 'main.ts'), 'utf8')).toBe('merged')
  })
  it('refuses terminal bytes changed since the captured comparison', async () => {
    await writeFile(join(workspace, 'main.ts'), 'new terminal changes')
    expect(await apply()).toEqual({ error: 'SOURCE_WORKSPACE_CHANGED' })
    expect(await readFile(join(workspace, 'main.ts'), 'utf8')).toBe('new terminal changes')
  })
  it('fences superseded revisions even if the client repeats an old review', async () => {
    await apply(item({ revision: 3, content: 'newer' }))
    expect(await apply()).toEqual({ error: 'SOURCE_SUPERSEDED' })
    expect(await readFile(join(workspace, 'main.ts'), 'utf8')).toBe('newer')
  })
  it('does not associate two contents with one journal revision', async () => {
    await apply()
    expect(await apply(item({ content: 'different' }))).toEqual({ error: 'SOURCE_REVISION_MISMATCH' })
  })
  it.each([false, true])('repairs an interrupted application (deletion=%s) without accepting an older write', async deleted => {
    const input = item({ revision: 3, content: deleted ? null : 'resolved' })
    expect(await apply(input, true)).toEqual({ error: 'INTERRUPTED' })
    expect(await readFile(join(workspace, 'main.ts'), 'utf8')).toBe('captured')
    expect(await apply()).toEqual({ error: 'SOURCE_SUPERSEDED' })
    expect(await apply(input)).toEqual({ path: 'main.ts', revision: 3, deleted })
    expect(await apply(input)).toEqual({ path: 'main.ts', revision: 3, deleted })
    if (deleted) await expect(readFile(join(workspace, 'main.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
    else expect(await readFile(join(workspace, 'main.ts'), 'utf8')).toBe('resolved')
  })
  it('can preserve the saved absence of an untracked terminal file at revision zero', async () => {
    expect(await apply(item({ revision: 0, content: null }))).toEqual({ path: 'main.ts', revision: 0, deleted: true })
    await expect(readFile(join(workspace, 'main.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await apply(item({ revision: 0, content: null }))).toEqual({ path: 'main.ts', revision: 0, deleted: true })
  })
  it('requires every command supervisor to release its shared admission lock', async () => {
    await mkdir(runtime); await writeFile(join(runtime, 'commands.lock'), '')
    const child = spawn('python3', ['-I', '-S', '-u', '-c', 'import fcntl,sys; f=open(sys.argv[1]); fcntl.flock(f,fcntl.LOCK_SH); print("locked",flush=True); sys.stdin.read()', join(runtime, 'commands.lock')])
    try {
      await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('error', reject) })
      expect(await apply()).toEqual({ error: 'SOURCE_COMMANDS_RUNNING' })
      expect(await readFile(join(workspace, 'main.ts'), 'utf8')).toBe('captured')
    } finally { child.stdin.end(); await new Promise(resolve => child.once('exit', resolve)) }
    expect((await apply()).revision).toBe(2)
  })
  it('fails closed during shutdown', async () => {
    await mkdir(runtime); await writeFile(join(runtime, 'closing'), '')
    expect(await apply()).toEqual({ error: 'SANDBOX_CLOSING' })
    expect(await readFile(join(workspace, 'main.ts'), 'utf8')).toBe('captured')
  })
  it('does not follow a symlink or replace its target', async () => {
    const outside = join(root, 'outside'); await writeFile(outside, 'untouched')
    await symlink(outside, join(workspace, 'link.ts'))
    expect(await apply(item({ path: 'link.ts' }))).toEqual({ error: 'SOURCE_PATH_UNSAFE' })
    expect(await readFile(outside, 'utf8')).toBe('untouched')
  })
  it.each([{ path: '../escape' }, { content: '🙂'.repeat(65537) }, { expectedDigest: 'invalid' }, { revision: -1 }, { revision: 0 }])('rejects invalid application input', async invalid => {
    expect((await apply(item(invalid))).error).toBeTruthy()
    expect(await readFile(join(workspace, 'main.ts'), 'utf8')).toBe('captured')
  })
})

describe('resolution transport', () => {
  it('executes fixed isolated code and passes only digest-authenticated source data', async () => {
    const runCommand = vi.fn().mockResolvedValueOnce({ exitCode: 0, stdout: async () => JSON.stringify({ applied: { path: 'main.ts', revision: 2, deleted: false } }) }).mockResolvedValueOnce({ exitCode: 0 })
    const writeFiles = vi.fn()
    await applySandboxResolution({ cwd: '/vercel', runCommand, writeFiles } as never, item())
    const uploaded = writeFiles.mock.calls[0][0][0]
    expect(JSON.parse(uploaded.content.toString())).toEqual(item())
    expect(runCommand.mock.calls[0][0]).toMatchObject({ cmd: '/usr/bin/python3', cwd: '/', sudo: true, timeoutMs: 5000,
      args: ['-I', '-S', '-c', SOURCE_RESOLUTION_PROGRAM, uploaded.path, hash(uploaded.content), '/vercel'] })
    expect(runCommand.mock.calls[1][0]).toMatchObject({ cmd: '/usr/bin/rm', args: ['-f', '--', uploaded.path], sudo: false })
  })
  it('refuses to acknowledge a mismatched application receipt', async () => {
    const runCommand = vi.fn().mockResolvedValueOnce({ exitCode: 0, stdout: async () => JSON.stringify({ applied: { path: 'other.ts', revision: 2, deleted: false } }) }).mockResolvedValueOnce({ exitCode: 0 })
    await expect(applySandboxResolution({ cwd: '/vercel', runCommand, writeFiles: vi.fn() } as never, item())).rejects.toMatchObject({ code: 'SOURCE_RECEIPT_INVALID' })
  })
})
