// Opt-in upstream SDK diagnostic. One short-lived VM, synthetic output only.
import { Sandbox } from '@vercel/sandbox'
import { randomUUID } from 'node:crypto'

const credentials = {
  token: process.env.VERCEL_AUTH_TOKEN,
  teamId: process.env.VERCEL_TEAM_ID,
  projectId: process.env.VERCEL_PROJECT_ID,
}
if (Object.values(credentials).some((value) => !value)) throw new Error('Load the sandbox credentials first.')
const sandbox = await Sandbox.create({ ...credentials, name: `codetutor-diagnostic-${randomUUID()}`, persistent: false, timeout: 120_000, signal: AbortSignal.timeout(45_000) })
let corrupt = false
try {
  const vm = sandbox.currentSession()
  for (const count of [1, 25_000]) {
    const cmd = await vm.runCommand({ cmd: 'node', args: ['-e', `process.stdout.write('🙂\\n'.repeat(${count}));process.stderr.write('end')`], detached: true, timeoutMs: 30_000, signal: AbortSignal.timeout(10_000) })
    let text = ''
    for await (const line of cmd.logs({ signal: AbortSignal.timeout(15_000) })) if (line.stream === 'stdout') text += line.data
    const status = await vm.getCommand(cmd.cmdId, { signal: AbortSignal.timeout(5_000) })
    const waited = await cmd.wait({ signal: AbortSignal.timeout(5_000) })
    const afterWait = await vm.getCommand(cmd.cmdId, { signal: AbortSignal.timeout(5_000) })
    console.log({ count, expectedBytes: count * 5, actualBytes: Buffer.byteLength(text), replacements: [...text].filter((c) => c === '\uFFFD').length, statusExitCode: status.exitCode, waitExitCode: waited.exitCode, afterWaitExitCode: afterWait.exitCode })
    if (text !== '🙂\n'.repeat(count)) corrupt = true
  }
} finally {
  await sandbox.stop({ signal: AbortSignal.timeout(10_000) })
  console.log('Stopped the diagnostic sandbox.')
}
if (corrupt) throw new Error('Raw upstream Sandbox logs corrupted synthetic Unicode output. Verify the application mitigation separately with the encoded command-output tests.')
