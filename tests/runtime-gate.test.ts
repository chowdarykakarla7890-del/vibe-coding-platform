import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { SHUTDOWN_GUARD_PROGRAM, quiesceSandboxRuntime } from '@/lib/sandbox/shutdown-guard'
import { initializeSandboxRuntime } from '@/lib/sandbox/runtime-gate'
import { COMMAND_GATE_PROGRAM } from '@/lib/sandbox/runtime-programs.mjs'
import { gatedCommand, guardedCommand } from '@/lib/server/command-guard'

const execute = promisify(execFile)
let directory: string, workspace: string, runtime: string, state: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'codetutor-runtime-test-'))
  workspace = join(directory, 'workspace'); runtime = join(directory, 'runtime'); state = join(directory, 'source')
  await mkdir(workspace)
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }); vi.restoreAllMocks() })

async function run(body: string) {
  // Only filesystem fixtures/owner and the Linux process scanner are replaced.
  // No test may signal a local process. A separate real-VM test verifies that.
  const runner = `
scope = {'__name__': 'test'}
exec(${JSON.stringify(SHUTDOWN_GUARD_PROGRAM)}, scope)
import os, json, sys, fcntl
workspace, runtime, state = sys.argv[1:]
scope['kill_learner_namespaces'] = lambda owner: 0
initialize = lambda: scope['initialize_runtime'](runtime, os.getuid())
acquire = lambda: scope['acquire_command_gate'](runtime, os.getuid())
close = lambda: scope['close_runtime'](workspace, runtime, state, os.getuid())
apply = lambda revision, content: scope['apply']([{'path': 'main.ts', 'content': content, 'revision': revision}], workspace, state, os.getuid(), runtime)
${body}
`
  const result = await execute('python3', ['-I', '-S', '-c', runner, workspace, runtime, state], { timeout: 10_000, maxBuffer: 1024 * 1024 })
  return JSON.parse(result.stdout)
}

describe('VM admission and source shutdown fence', () => {
  it('creates read-only control files and an inheritable supervisor lock', async () => {
    expect(await run(`
initialize()
fd = acquire()
print(json.dumps({'inherit': os.get_inheritable(fd), 'mode': os.stat(runtime + '/commands.lock').st_mode & 0o777, 'directoryMode': os.stat(runtime).st_mode & 0o777}))
os.close(fd)
`)).toEqual({ inherit: true, mode: 0o644, directoryMode: 0o755 })
  })

  it('closes idempotently, never reopens on initialization, and rejects new commands', async () => {
    expect(await run(`
initialize()
assert close() == {'closed': True}
assert close() == {'closed': True}
errors = []
for operation in (initialize, acquire):
    try: operation()
    except scope['RuntimeGateFailure'] as error: errors.append(error.code)
print(json.dumps(errors))
`)).toEqual(['SANDBOX_CLOSING', 'SANDBOX_CLOSING'])
  })

  it('preserves source and revisions while rejecting delayed writes after closure', async () => {
    expect(await run(`
initialize()
apply(1, 'saved source')
close()
try: apply(2, 'late source')
except scope['ApplyFailure'] as error: print(json.dumps(error.code))
`)).toBe('SANDBOX_CLOSING')
    expect(await readFile(join(workspace, 'main.ts'), 'utf8')).toBe('saved source')
  })

  it('fails closed when a command supervisor still holds its lease', async () => {
    expect(await run(`
initialize()
held = acquire()
# Force only the deadline; kernel locking stays real.
clock = iter([0, 20])
scope['time'].monotonic = lambda: next(clock)
try: close()
except scope['RuntimeGateFailure'] as error: print(json.dumps({'error': error.code, 'closed': os.path.exists(runtime + '/closing')}))
os.close(held)
`)).toEqual({ error: 'RUNTIME_QUIESCE_UNCONFIRMED', closed: true })
  })

  it('waits for an existing source writer instead of reporting a safe shutdown', async () => {
    expect(await run(`
initialize()
apply(1, 'retained')
held = os.open(state + '/apply.lock', os.O_RDONLY)
fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
clock = iter([0, 20])
scope['time'].monotonic = lambda: next(clock)
try: close()
except scope['RuntimeGateFailure'] as error: print(json.dumps(error.code))
os.close(held)
`)).toBe('RUNTIME_QUIESCE_UNCONFIRMED')
  })

  it('retains the closing marker when process termination cannot be confirmed', async () => {
    expect(await run(`
initialize()
def failed_kill(owner): raise scope['RuntimeGateFailure']('RUNTIME_PROCESS_LIMIT')
scope['kill_learner_namespaces'] = failed_kill
try: close()
except scope['RuntimeGateFailure'] as error: print(json.dumps({'error': error.code, 'closed': os.path.exists(runtime + '/closing')}))
`)).toEqual({ error: 'RUNTIME_PROCESS_LIMIT', closed: true })
  })

  it('reads kernel UID and namespace identity rather than trusting /proc directory ownership', async () => {
    expect(await run(`
status = workspace + '/status'
with open(status, 'w') as stream: stream.write('Name:\\ttest\\nUid:\\t1000\\t1000\\t1000\\t1000\\nNSpid:\\t100\\t1\\n')
print(json.dumps(scope['process_identity'](status)))
`)).toEqual([1000, [100, 1]])
  })

  it.each(['directory', 'lock-symlink', 'writable-lock', 'linked-lock'])('rejects unsafe control state: %s', async (kind) => {
    expect(await run(`
initialize()
kind = ${JSON.stringify(kind)}
if kind == 'directory': os.chmod(runtime, 0o777)
if kind == 'writable-lock': os.chmod(runtime + '/commands.lock', 0o666)
if kind == 'lock-symlink':
    os.rename(runtime + '/commands.lock', runtime + '/target')
    os.symlink(runtime + '/target', runtime + '/commands.lock')
if kind == 'linked-lock': os.link(runtime + '/commands.lock', runtime + '/alias')
try:
    fd = acquire()
    os.close(fd)
    print(json.dumps(False))
except (scope['RuntimeGateFailure'], OSError): print(json.dumps(True))
`)).toBe(true)
  })

  it('preserves argv, PID isolation and non-root execution through the gate', () => {
    const args = ['a b', '$(not executed)', '--sudo']
    const command = gatedCommand('node', args)
    expect(command.sudo).toBe(false)
    expect(command.cmd).toBe('/usr/bin/python3')
    expect(command.args.slice(0, 4)).toEqual(['-I', '-S', '-c', COMMAND_GATE_PROGRAM])
    expect(command.args.slice(4)).toEqual(guardedCommand('node', args).args)
    expect(command.args.slice(-4)).toEqual(['node', ...args])
  })
})

describe('fixed-session gate transport', () => {
  it('initializes with only fixed management code and an explicit deadline', async () => {
    const runCommand = vi.fn(async () => ({ exitCode: 0, stdout: async () => '{"ready":true}' }))
    await initializeSandboxRuntime({ runCommand } as never)
    expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({ cmd: '/usr/bin/python3', cwd: '/', sudo: true, timeoutMs: 2_000, signal: expect.any(AbortSignal) }))
  })

  it('maps a closed gate without exposing raw runtime output', async () => {
    const runCommand = vi.fn(async () => ({ exitCode: 1, stdout: async () => '{"error":"SANDBOX_CLOSING","detail":"private"}' }))
    await expect(initializeSandboxRuntime({ runCommand } as never)).rejects.toMatchObject({ code: 'SANDBOX_CLOSING', message: 'SANDBOX_CLOSING' })
  })

  it.each(['{}', 'null', '{"closed":false}', 'raw secret'])('rejects an unconfirmed quiesce receipt: %s', async (receipt) => {
    const vm = { cwd: '/vercel', runCommand: vi.fn(async () => ({ exitCode: 0, stdout: async () => receipt })), stop: vi.fn() }
    await expect(quiesceSandboxRuntime(vm as never)).rejects.toMatchObject({ name: 'ShutdownGuardError' })
    expect(vm.stop).not.toHaveBeenCalled()
  })

  it('confirms quiescence but does not itself stop the VM or discard source', async () => {
    const vm = { cwd: '/vercel', runCommand: vi.fn(async () => ({ exitCode: 0, stdout: async () => '{"closed":true}' })), stop: vi.fn() }
    await quiesceSandboxRuntime(vm as never)
    expect(vm.runCommand).toHaveBeenCalledWith(expect.objectContaining({ args: ['-I', '-S', '-c', SHUTDOWN_GUARD_PROGRAM, '/vercel'], timeoutMs: 9_000, sudo: true }))
    expect(vm.stop).not.toHaveBeenCalled()
  })

  it('does not launch management work after caller cancellation', async () => {
    const runCommand = vi.fn()
    await expect(quiesceSandboxRuntime({ cwd: '/vercel', runCommand } as never, AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' })
    expect(runCommand).not.toHaveBeenCalled()
  })
})
