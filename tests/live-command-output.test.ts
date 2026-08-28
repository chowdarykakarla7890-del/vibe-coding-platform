import { expect, it, vi } from 'vitest'
import { Sandbox } from '@vercel/sandbox'
import { randomUUID } from 'node:crypto'
import { encodedCommand } from '@/lib/server/command-guard'
import { readCommandLogs } from '@/lib/server/command-output'
import { initializeSandboxRuntime } from '@/lib/sandbox/runtime-gate'

vi.mock('server-only', () => ({}))
it.skipIf(process.env.RUN_LIVE_COMMAND_OUTPUT !== '1')('preserves encoded large Unicode and Stop in a real guarded VM', async () => {
  const vmName = `codetutor-output-${randomUUID()}`
  const sandbox = await Sandbox.create({ token: process.env.VERCEL_AUTH_TOKEN!, teamId: process.env.VERCEL_TEAM_ID!, projectId: process.env.VERCEL_PROJECT_ID!, name: vmName, persistent: false, timeout: 120_000, signal: AbortSignal.timeout(30_000) })
  try {
    const session = sandbox.currentSession()
    await initializeSandboxRuntime(session)
    const expected = '🙂你好 café\n'.repeat(25000)
    const command = await session.runCommand({ ...encodedCommand('node', ['-e', "process.stdout.write('🙂你好 café\\n'.repeat(25000));process.stderr.write('⚠️ end');process.exitCode=3"]), detached: true, timeoutMs: 30_000, signal: AbortSignal.timeout(10_000) })
    for (let replay = 0; replay < 2; replay++) {
      const result = { stdout: '', stderr: '' }
      for await (const item of readCommandLogs(command, 'base64-v1', AbortSignal.timeout(20_000))) result[item.stream] += item.data
      expect(result.stdout === expected).toBe(true)
      expect(result.stderr).toBe('⚠️ end')
      expect((await command.wait({ signal: AbortSignal.timeout(5_000) })).exitCode).toBe(3)
      console.log('PASS: live encoded UTF-8 transport', { bytes: Buffer.byteLength(result.stdout), replay })
    }
    const slow = await session.runCommand({ ...encodedCommand('sh', ['-c', 'sleep 120 & wait']), detached: true, timeoutMs: 60_000, signal: AbortSignal.timeout(10_000) })
    await slow.kill('SIGKILL', { abortSignal: AbortSignal.timeout(5_000) })
    expect((await slow.wait({ signal: AbortSignal.timeout(5_000) })).exitCode).not.toBeNull()
    console.log('PASS: encoded command tree Stop completes.')
    const timed = await session.runCommand({ ...encodedCommand('sh', ['-c', 'sleep 120 & wait']), detached: true, timeoutMs: 1500, signal: AbortSignal.timeout(10_000) })
    expect((await timed.wait({ signal: AbortSignal.timeout(6_000) })).exitCode).not.toBeNull()
    console.log('PASS: encoded command process deadline completes.')
  } finally {
    await sandbox.stop({ signal: AbortSignal.timeout(10_000) })
    console.log('Stopped the disposable output-transport sandbox.')
  }
}, 120_000)
