// Opt-in, one disposable VM; verifies the actual production process guard.
// REPRODUCE_UNGUARDED=1 reproduces the original child-process leak.
import assert from 'node:assert/strict'
import { Sandbox } from '@vercel/sandbox'
import { randomUUID } from 'node:crypto'
import { guardedCommand } from '../lib/server/command-guard.ts'

const credentials = { token: process.env.VERCEL_AUTH_TOKEN, teamId: process.env.VERCEL_TEAM_ID, projectId: process.env.VERCEL_PROJECT_ID }
if (Object.values(credentials).some((value) => !value)) throw new Error('Load sandbox credentials first.')
const sandbox = await Sandbox.create({ ...credentials, name: `codetutor-stop-check-${randomUUID()}`, persistent: false, timeout: 120_000, signal: AbortSignal.timeout(45_000) })
try {
  const vm = sandbox.currentSession()
  const launch = (args, timeoutMs) => vm.runCommand({
    ...(process.env.REPRODUCE_UNGUARDED === '1' ? { cmd: '/usr/bin/setpriv', args: ['--no-new-privs', '--', 'sh', ...args], sudo: false } : guardedCommand('sh', args)),
    detached: true, timeoutMs, signal: AbortSignal.timeout(10_000),
  })
  for (const mode of ['stop', 'timeout']) {
    const command = await launch(['-c', 'sleep 60 & setsid sleep 61 & echo ready; wait'], mode === 'stop' ? 60_000 : 2_000)
    const logs = command.logs({ signal: AbortSignal.timeout(5_000) })
    try { assert.equal((await logs.next()).value?.data.trim(), 'ready', 'Wait for both child processes before stopping') }
    finally { logs.close() }
    const start = Date.now()
    if (mode === 'stop') await command.kill('SIGKILL', { abortSignal: AbortSignal.timeout(5_000) })
    const ended = await command.wait({ signal: AbortSignal.timeout(8_000) })
    assert.notEqual(ended.exitCode, 0)
    const children = await vm.runCommand({ cmd: 'pgrep', args: ['-x', 'sleep'], timeoutMs: 3_000, signal: AbortSignal.timeout(5_000) })
    assert.equal(children.exitCode, 1, 'No regular or setsid child may survive the command')
    console.log('PASS: process-tree cleanup', { mode, durationMs: Date.now() - start, exitCode: ended.exitCode })
  }
  const identity = await launch(['-c', 'id -u; grep -E "NoNewPrivs|CapEff|CapBnd" /proc/self/status; touch isolation-check && test -f isolation-check && node --version && npm --version'], 5_000)
  const text = await identity.stdout({ signal: AbortSignal.timeout(8_000) })
  assert.equal((await identity.wait({ signal: AbortSignal.timeout(5_000) })).exitCode, 0)
  assert.notEqual(text.split('\n')[0], '0')
  assert.match(text, /NoNewPrivs:\s+1/)
  assert.match(text, /CapEff:\s+0+\s/)
  assert.match(text, /CapBnd:\s+0+\s/)
  console.log('PASS: unprivileged, capability-free execution with writable workspace and Node/npm available.')
} finally {
  await sandbox.stop({ signal: AbortSignal.timeout(15_000) })
  console.log('Stopped diagnostic VM.')
}
