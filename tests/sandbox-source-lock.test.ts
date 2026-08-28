import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { SOURCE_APPLY_PROGRAM } from '@/lib/sandbox/source-apply'
import { SOURCE_CAPTURE_PROGRAM } from '@/lib/sandbox/source-capture'
import { SOURCE_ACK_PROGRAM } from '@/lib/sandbox/source-ack'
import { SOURCE_RESOLUTION_PROGRAM } from '@/lib/sandbox/source-resolution-apply'
import { SHUTDOWN_GUARD_PROGRAM } from '@/lib/sandbox/shutdown-guard'

const execute = promisify(execFile)
let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'codetutor-source-lock-test-'))
  await mkdir(join(directory, 'workspace'))
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

async function run(body: string, program = SOURCE_APPLY_PROGRAM) {
  const runner = `
scope = {'__name__': 'test'}
exec(${JSON.stringify(program)}, scope)
import errno, fcntl, hashlib, json, os, sys
workspace, state, runtime = sys.argv[1:]
uid = os.getuid()
apply = lambda revision: scope['apply']([{'path': 'main.ts', 'content': 'revision ' + str(revision), 'revision': revision}], workspace, state, uid, runtime)
${body}
`
  const { stdout } = await execute(process.env.CODETUTOR_TEST_PYTHON ?? 'python3', ['-I', '-S', '-c', runner,
    join(directory, 'workspace'), join(directory, 'state'), join(directory, 'runtime')], { timeout: 10_000, maxBuffer: 64 * 1024 })
  return JSON.parse(stdout)
}

const transientOpen = `
original = scope['os'].open
calls = 0
def transient(path, flags, *args, **kwargs):
    global calls
    if path == 'apply.lock':
        calls += 1
        assert flags & os.O_NOFOLLOW and flags & os.O_NONBLOCK
        assert kwargs.get('dir_fd') is not None
        if calls == 1: raise FileNotFoundError(errno.ENOENT, 'fixture')
    return original(path, flags, *args, **kwargs)
scope['os'].open = transient
`

describe('trusted source lock initialization', () => {
  it('recovers a transient first-creation ENOENT before applying source', async () => {
    expect(await run(`
${transientOpen}
result = apply(1)
with open(workspace + '/main.ts') as stream: content = stream.read()
print(json.dumps({'calls': calls, 'result': result, 'content': content}))
`)).toEqual({ calls: 2, result: [{ path: 'main.ts', revision: 1 }], content: 'revision 1' })
  })

  it.each([
    ['capture', SOURCE_CAPTURE_PROGRAM, "scope['capture'](workspace, ['main.ts'], state, uid)"],
    ['acknowledge', SOURCE_ACK_PROGRAM, "scope['acknowledge']([{'path': 'main.ts', 'revision': 1, 'digest': digest}], workspace, state, uid)"],
    ['resolve', SOURCE_RESOLUTION_PROGRAM, "scope['apply_resolution']({'path': 'main.ts', 'content': 'revision 2', 'revision': 2, 'expectedDigest': digest}, workspace, state, runtime, uid)"],
    ['shutdown', SHUTDOWN_GUARD_PROGRAM, "scope['close_runtime'](workspace, runtime, state, uid)"],
  ])('shares the guarded open with %s without replacing the lock inode', async (_name, program, invocation) => {
    expect(await run(`
apply(1)
inode = os.stat(state + '/apply.lock').st_ino
digest = hashlib.sha256(b'revision 1').hexdigest()
# The process scanner must never signal local processes in filesystem tests.
scope['kill_learner_namespaces'] = lambda owner: 0
${transientOpen}
result = ${invocation}
print(json.dumps({'calls': calls, 'sameInode': inode == os.stat(state + '/apply.lock').st_ino, 'completed': result is not None}))
`, program)).toEqual({ calls: 2, sameInode: true, completed: true })
  })

  it('bounds repeated ENOENT to three attempts and leaves source untouched', async () => {
    expect(await run(`
original = scope['os'].open
calls, sleeps = 0, []
def missing(path, flags, *args, **kwargs):
    global calls
    if path == 'apply.lock':
        calls += 1
        raise FileNotFoundError(errno.ENOENT, 'fixture')
    return original(path, flags, *args, **kwargs)
scope['os'].open = missing
scope['time'].monotonic = lambda: 0
scope['time'].sleep = sleeps.append
try: apply(1)
except scope['ApplyFailure'] as error:
    print(json.dumps({'code': error.code, 'calls': calls, 'sleeps': sleeps, 'files': os.listdir(workspace)}))
`)).toEqual({ code: 'SOURCE_APPLY_BUSY', calls: 3, sleeps: [0.02, 0.02], files: [] })
  })

  it('shares the original five-second deadline with kernel lock contention', async () => {
    expect(await run(`
apply(1)
held = os.open(state + '/apply.lock', os.O_RDONLY)
fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
${transientOpen}
clock, sleeps = iter([0, 4.99, 5]), []
scope['time'].monotonic = lambda: next(clock)
scope['time'].sleep = sleeps.append
try: apply(2)
except scope['ApplyFailure'] as error:
    with open(workspace + '/main.ts') as stream: content = stream.read()
    print(json.dumps({'code': error.code, 'calls': calls, 'sleep': round(sum(sleeps), 2), 'content': content}))
finally: os.close(held)
`)).toEqual({ code: 'SOURCE_APPLY_BUSY', calls: 2, sleep: 0.01, content: 'revision 1' })
  })

  it.each([13, 28, 5])('does not retry unrelated OS error %s', async (errorNumber) => {
    expect(await run(`
original = scope['os'].open
calls = 0
def broken(path, flags, *args, **kwargs):
    global calls
    if path == 'apply.lock':
        calls += 1
        raise OSError(${errorNumber}, 'fixture')
    return original(path, flags, *args, **kwargs)
scope['os'].open = broken
try: apply(1)
except OSError as error: print(json.dumps({'errno': error.errno, 'calls': calls, 'files': os.listdir(workspace)}))
`)).toEqual({ errno: errorNumber, calls: 1, files: [] })
  })

  it.each(['symlink', 'hardlink', 'fifo', 'directory', 'public', 'foreign-owner'])('rejects unsafe lock: %s', async (kind) => {
    expect(await run(`
os.mkdir(state, 0o700)
path = state + '/apply.lock'
kind = ${JSON.stringify(kind)}
if kind == 'directory': os.mkdir(path)
elif kind == 'fifo': os.mkfifo(path, 0o600)
elif kind == 'symlink':
    with open(state + '/target', 'w') as stream: stream.write('untouched')
    os.symlink(state + '/target', path)
else:
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(fd)
    if kind == 'hardlink': os.link(path, state + '/alias')
    if kind == 'public': os.chmod(path, 0o666)
parent = scope['open_directory'](state, uid)
try:
    fd = scope['open_source_lock'](parent, uid + 1 if kind == 'foreign-owner' else uid, scope['time'].monotonic() + 5)
    os.close(fd)
    print(json.dumps({'rejected': False}))
except (OSError, scope['ApplyFailure']):
    intact = True
    if kind == 'symlink':
        with open(state + '/target') as stream: intact = stream.read() == 'untouched'
    print(json.dumps({'rejected': True, 'intact': intact, 'files': os.listdir(workspace)}))
finally: os.close(parent)
`)).toEqual({ rejected: true, intact: true, files: [] })
  })

  it('closes the opened descriptor when lock validation fails', async () => {
    expect(await run(`
os.mkdir(state, 0o700)
parent = scope['open_directory'](state, uid)
original, opened = scope['os'].open, []
def tracked(path, *args, **kwargs):
    fd = original(path, *args, **kwargs)
    if path == 'apply.lock': opened.append(fd)
    return fd
scope['os'].open = tracked
try: scope['open_source_lock'](parent, uid + 1, scope['time'].monotonic() + 5)
except scope['ApplyFailure']:
    try: os.fstat(opened[0])
    except OSError as error: print(json.dumps({'closed': error.errno == errno.EBADF}))
finally: os.close(parent)
`)).toEqual({ closed: true })
  })
})
