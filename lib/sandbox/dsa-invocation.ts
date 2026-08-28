import { DSA_RUNNER_PROGRAM } from './dsa-program.mjs'
import { COMMAND_OUTPUT_PROGRAM } from './output-program.mjs'
import { DSA_REGISTER_PROGRAM, DSA_STOP_PROGRAM } from './dsa-control.mjs'
import type { Session } from '@vercel/sandbox'

/** Fixed privileged supervisors only; neither executable nor program text is
 * selected by the caller. The supervisor compiles/runs source unprivileged. */
export function trustedDSACommand(path: string, digest: string) {
  if (!/^\/tmp\/\.codetutor-grade-[a-f0-9-]{36}\.json$/.test(path) || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid grading payload reference')
  return { cmd: '/usr/bin/python3', cwd: '/', sudo: true as const,
    args: ['-I', '-S', '-c', DSA_REGISTER_PROGRAM, path, '--pid', '--fork', '--kill-child=KILL', '--', '/usr/bin/python3', '-I', '-S', '-c', COMMAND_OUTPUT_PROGRAM,
      '/usr/bin/python3', '-I', '-S', '-c', DSA_RUNNER_PROGRAM, path, digest] }
}

export async function stopDSAGrading(vm: Pick<Session, 'runCommand'>, path: string, signal: AbortSignal) {
  if (!/^\/tmp\/\.codetutor-grade-[a-f0-9-]{36}\.json$/.test(path)) throw new Error('Invalid grading payload reference')
  const result = await vm.runCommand({ cmd: '/usr/bin/python3', args: ['-I', '-S', '-c', DSA_STOP_PROGRAM, path],
    cwd: '/', sudo: true, timeoutMs: 5000, signal })
  if (result.exitCode !== 0) throw new Error('Grading termination could not be confirmed.')
}
