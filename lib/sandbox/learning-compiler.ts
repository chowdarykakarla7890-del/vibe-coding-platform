import type { Session } from '@vercel/sandbox'
import { abortableRead } from '@/lib/abortable-read'

/** Server-selected curated compiler only, on a new VM before attachment.
 * Does not execute a manifest command or claim a trusted grading runtime. */
export async function prepareLearningCompiler(vm: Pick<Session, 'runCommand'>, language: 'Java' | 'C++', callerSignal?: AbortSignal) {
  const signal = AbortSignal.any([AbortSignal.timeout(45_000), ...(callerSignal ? [callerSignal] : [])])
  signal.throwIfAborted()
  const commands = [
    { args: ['update'], timeoutMs: 15_000 },
    { args: ['install', '-y', '--no-install-recommends', language === 'Java' ? 'openjdk-21-jdk-headless' : 'g++'], timeoutMs: 35_000 },
  ]
  for (const command of commands) {
    signal.throwIfAborted()
    const result = await abortableRead(() => vm.runCommand({ cmd: '/usr/bin/apt-get', ...command, cwd: '/',
      env: { DEBIAN_FRONTEND: 'noninteractive' }, sudo: true, signal }), signal)
    if (result.exitCode !== 0) throw new Error('The activity compiler could not be prepared. Please retry startup.')
  }
}
