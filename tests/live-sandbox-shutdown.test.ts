import { expect, it } from 'vitest'
import { Sandbox } from '@vercel/sandbox'
import { gatedCommand, guardedCommand } from '@/lib/server/command-guard'
import { initializeSandboxRuntime } from '@/lib/sandbox/runtime-gate'
import { quiesceSandboxRuntime } from '@/lib/sandbox/shutdown-guard'
import { applySandboxSource } from '@/lib/sandbox/source-apply'
import { captureSandboxSource } from '@/lib/sandbox/source-capture'

// Explicit opt-in: one short-lived paid VM, no AI or database/customer records.
// This verifies the real Linux process/lock boundary, not the full Stop API.
it.skipIf(process.env.RUN_LIVE_SHUTDOWN_GUARD !== '1')('quiesces real learner processes and rejects late command/source writes without destroying source', async () => {
  const credentials = { token: process.env.VERCEL_AUTH_TOKEN, teamId: process.env.VERCEL_TEAM_ID, projectId: process.env.VERCEL_PROJECT_ID }
  if (Object.values(credentials).some((value) => !value)) throw new Error('Load Sandbox configuration first.')
  const name = `codetutor-shutdown-check-${crypto.randomUUID()}`
  let sandbox: Sandbox | undefined
  try {
    sandbox = await Sandbox.create({ ...credentials, name, persistent: false, timeout: 180_000, signal: AbortSignal.timeout(45_000) })
    const vm = sandbox.currentSession()
    await initializeSandboxRuntime(vm)
    await applySandboxSource(vm, [{ path: 'main.ts', content: 'saved before terminal', revision: 1 }])
    const identity = await vm.runCommand({ ...gatedCommand('sh', ['-c', 'id -u; grep -E "NoNewPrivs|CapEff|CapBnd" /proc/self/status; node --version']), timeoutMs: 5_000, signal: AbortSignal.timeout(8_000) })
    const identityText = await identity.stdout({ signal: AbortSignal.timeout(5_000) })
    expect(identity.exitCode).toBe(0)
    expect(identityText.split('\n')[0]).not.toBe('0')
    expect(identityText).toMatch(/NoNewPrivs:\s+1/)
    expect(identityText).toMatch(/CapEff:\s+0+\s/)
    expect(identityText).toMatch(/CapBnd:\s+0+\s/)

    // Closing inherited descriptors in learner code must not release the
    // unshare supervisor's copy. A setsid child must not escape termination.
    const program = 'import os,time,subprocess; os.closerange(3,65536); subprocess.Popen(["sleep","100"],start_new_session=True); open("main.ts","w").write("terminal final"); print("ready",flush=True); time.sleep(100)'
    const command = await vm.runCommand({ ...gatedCommand('/usr/bin/python3', ['-I', '-S', '-c', program]), detached: true, timeoutMs: 110_000, signal: AbortSignal.timeout(8_000) })
    const logs = command.logs({ signal: AbortSignal.timeout(6_000) })
    try { expect((await logs.next()).value?.data.trim()).toBe('ready') } finally { logs.close() }
    const locked = await vm.runCommand({ cmd: '/usr/bin/flock', args: ['--exclusive', '--nonblock', '/var/lib/codetutor-runtime-v1/commands.lock', 'true'], sudo: true, timeoutMs: 2_000, signal: AbortSignal.timeout(5_000) })
    expect(locked.exitCode, 'Supervisor must hold admission lock after learner closes its own descriptors').toBe(1)
    const legacy = await vm.runCommand({ ...guardedCommand('/usr/bin/python3', ['-I', '-S', '-c', 'import ctypes,time; assert ctypes.CDLL(None).prctl(4,0,0,0,0)==0; print("private-ready",flush=True); time.sleep(99)']), detached: true, timeoutMs: 110_000, signal: AbortSignal.timeout(5_000) })
    const legacyLogs = legacy.logs({ signal: AbortSignal.timeout(5_000) })
    try { expect((await legacyLogs.next()).value?.data.trim()).toBe('private-ready') } finally { legacyLogs.close() }

    await quiesceSandboxRuntime(vm)
    expect((await command.wait({ signal: AbortSignal.timeout(5_000) })).exitCode).not.toBe(0)
    expect((await legacy.wait({ signal: AbortSignal.timeout(5_000) })).exitCode).not.toBe(0)
    const children = await vm.runCommand({ cmd: '/usr/bin/pgrep', args: ['-x', 'sleep'], timeoutMs: 2_000, signal: AbortSignal.timeout(5_000) })
    expect(children.exitCode, 'Neither setsid descendants nor an older guarded namespace may survive').toBe(1)
    const late = await vm.runCommand({ ...gatedCommand('sh', ['-c', 'echo forbidden > late.ts']), timeoutMs: 2_000, signal: AbortSignal.timeout(5_000) })
    expect(late.exitCode).toBe(75)
    await expect(initializeSandboxRuntime(vm)).rejects.toMatchObject({ code: 'SANDBOX_CLOSING' })
    await expect(applySandboxSource(vm, [{ path: 'main.ts', content: 'late editor', revision: 2 }])).rejects.toMatchObject({ code: 'SANDBOX_CLOSING' })
    await quiesceSandboxRuntime(vm) // A lost receipt is safe to retry.
    const captured = await captureSandboxSource(vm, ['main.ts'])
    expect(captured.complete).toBe(true)
    expect(captured.entries.find((entry) => entry.path === 'main.ts')).toMatchObject({ kind: 'file', content: 'terminal final', baseRevision: 1, pending: false })
    expect(captured.entries.some((entry) => entry.path === 'late.ts')).toBe(false)
    expect(vm.status).toBe('running') // Quiescence is not VM destruction.
    console.log('PASS: gate inheritance, non-root isolation, namespace-tree cleanup, late-write fencing and retained source capture.')
  } finally {
    const cleanup = sandbox ?? await Sandbox.get({ name, resume: false, ...credentials, signal: AbortSignal.timeout(10_000) }).catch(() => undefined)
    if (cleanup) await cleanup.stop({ signal: AbortSignal.timeout(15_000) })
    console.log('Stopped disposable shutdown-guard VM.')
  }
}, 120_000)
