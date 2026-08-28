import type { Session } from '@vercel/sandbox'
import { abortableRead } from '@/lib/abortable-read'
import { SOURCE_FILESYSTEM_PROGRAM } from './source-apply'

/** Close command admission, terminate only learner PID namespaces, and wait
 * for both command supervisors and source application to leave their locks.
 * Failure leaves the close marker in place; it never destroys or reopens a VM.
 * The caller must capture and commit source before actually stopping the VM. */
export const SHUTDOWN_GUARD_PROGRAM = SOURCE_FILESYSTEM_PROGRAM + String.raw`
import signal

def process_identity(path):
    uid = ids = None
    with open(path, 'r') as stream:
        for line in stream:
            if line.startswith('NSpid:'): ids = [int(value) for value in line.split()[1:]]
            if line.startswith('Uid:'): uid = int(line.split()[1])
    if uid is None or ids is None: runtime_fail('RUNTIME_GATE_UNAVAILABLE')
    return uid, ids

def kill_learner_namespaces(owner):
    if owner == 0 or not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
        runtime_fail('RUNTIME_GATE_UNAVAILABLE')
    depth = len(process_identity('/proc/self/status')[1])
    found = 0
    with os.scandir('/proc') as listing:
        visited = 0
        for item in listing:
            if not item.name.isdecimal(): continue
            visited += 1
            if visited > 8192: runtime_fail('RUNTIME_PROCESS_LIMIT')
            pidfd = None
            try:
                # Open the stable process handle first: a recycled numeric PID
                # must never cause a signal to target a replacement process.
                pidfd = os.pidfd_open(int(item.name), 0)
                # /proc/<pid> can become root-owned when a learner disables
                # dumpability. Read the kernel's real UID, not that directory.
                uid, ids = process_identity(item.path + '/status')
                if uid != owner: continue
                if len(ids) <= depth or ids[-1] != 1: continue
                signal.pidfd_send_signal(pidfd, signal.SIGKILL)
                found += 1
            except (ProcessLookupError, FileNotFoundError): pass
            finally:
                if pidfd is not None: os.close(pidfd)
    return found

def close_runtime(workspace, runtime_path='/var/lib/codetutor-runtime-v1', state_path='/var/lib/codetutor-source-v1', trusted_uid=0):
    try: initialize_runtime(runtime_path, trusted_uid)
    except RuntimeGateFailure as error:
        if error.code != 'SANDBOX_CLOSING': raise
    parent = runtime_directory(runtime_path, trusted_uid)
    command_lock = state = source_lock = root = None
    try:
        marker = runtime_file(parent, 'closing', os.O_WRONLY | os.O_CREAT, owner=trusted_uid)
        os.fsync(marker); os.close(marker); os.fsync(parent)
        command_lock = runtime_file(parent, 'commands.lock', os.O_RDONLY, owner=trusted_uid)
        try: os.mkdir(state_path, 0o700)
        except FileExistsError: pass
        state = open_directory(state_path, trusted_uid)
        if stat.S_IMODE(os.fstat(state).st_mode) & 0o077: fail('SOURCE_JOURNAL_INVALID')
        deadline = time.monotonic() + 7
        source_lock = open_source_lock(state, trusted_uid, deadline)
        root = os.open(workspace, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        owner = os.fstat(root).st_uid
        while True:
            killed = kill_learner_namespaces(owner)
            try:
                fcntl.flock(command_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                fcntl.flock(source_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                if not killed and not kill_learner_namespaces(owner): return {'closed': True}
            except BlockingIOError: pass
            if time.monotonic() >= deadline: runtime_fail('RUNTIME_QUIESCE_UNCONFIRMED')
            time.sleep(0.02)
    finally:
        for fd in (root, source_lock, state, command_lock, parent):
            if fd is not None: os.close(fd)

if __name__ == '__main__':
    try:
        if len(sys.argv) != 2 or not sys.argv[1].startswith('/') or sys.argv[1] == '/': runtime_fail('RUNTIME_GATE_UNAVAILABLE')
        print(json.dumps(close_runtime(sys.argv[1])))
    except (RuntimeGateFailure, ApplyFailure) as error:
        print(json.dumps({'error': error.code})); sys.exit(1)
    except BaseException:
        print(json.dumps({'error': 'RUNTIME_QUIESCE_UNCONFIRMED'})); sys.exit(1)
`

export class ShutdownGuardError extends Error {
  constructor() { super('Sandbox shutdown could not be made safe. Source has not been discarded.'); this.name = 'ShutdownGuardError' }
}

export async function quiesceSandboxRuntime(vm: Pick<Session, 'runCommand' | 'cwd'>, callerSignal?: AbortSignal) {
  const signal = AbortSignal.any([AbortSignal.timeout(12_000), ...(callerSignal ? [callerSignal] : [])])
  if (!vm.cwd?.startsWith('/') || vm.cwd === '/' || vm.cwd.includes('\0')) throw new ShutdownGuardError()
  try {
    const result = await abortableRead(() => vm.runCommand({ cmd: '/usr/bin/python3',
      args: ['-I', '-S', '-c', SHUTDOWN_GUARD_PROGRAM, vm.cwd], cwd: '/', sudo: true, timeoutMs: 9_000, signal }), signal)
    const receipt: unknown = JSON.parse(await abortableRead(() => result.stdout({ signal }), signal))
    if (result.exitCode !== 0 || !receipt || typeof receipt !== 'object' || !('closed' in receipt) || receipt.closed !== true) throw new ShutdownGuardError()
  } catch {
    signal.throwIfAborted()
    throw new ShutdownGuardError()
  }
}
