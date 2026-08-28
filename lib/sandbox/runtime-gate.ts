import type { Session } from '@vercel/sandbox'
import { abortableRead } from '@/lib/abortable-read'
import { RUNTIME_INITIALIZE_PROGRAM } from './runtime-programs.mjs'

export class RuntimeGateError extends Error {
  constructor(readonly code: 'SANDBOX_CLOSING' | 'RUNTIME_GATE_UNAVAILABLE') { super(code); this.name = 'RuntimeGateError' }
}

export async function initializeSandboxRuntime(vm: Pick<Session, 'runCommand'>, callerSignal?: AbortSignal) {
  const signal = AbortSignal.any([AbortSignal.timeout(5_000), ...(callerSignal ? [callerSignal] : [])])
  try {
    const result = await abortableRead(() => vm.runCommand({ cmd: '/usr/bin/python3',
      args: ['-I', '-S', '-c', RUNTIME_INITIALIZE_PROGRAM], cwd: '/', sudo: true, timeoutMs: 2_000, signal }), signal)
    const receipt: unknown = JSON.parse(await abortableRead(() => result.stdout({ signal }), signal))
    if (result.exitCode === 0 && receipt && typeof receipt === 'object' && 'ready' in receipt && receipt.ready === true) return
    if (receipt && typeof receipt === 'object' && 'error' in receipt && receipt.error === 'SANDBOX_CLOSING') throw new RuntimeGateError('SANDBOX_CLOSING')
    throw new RuntimeGateError('RUNTIME_GATE_UNAVAILABLE')
  } catch (error) {
    if (error instanceof RuntimeGateError) throw error
    signal.throwIfAborted()
    throw new RuntimeGateError('RUNTIME_GATE_UNAVAILABLE')
  }
}
