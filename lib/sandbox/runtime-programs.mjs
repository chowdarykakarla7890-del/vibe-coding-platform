/** Root-owned control files, outside learner source. The command lock is
 * readable (not writable) by the learner; only trusted management sets closing.
 * No user code runs with root privileges and initialization never reopens it. */
export const RUNTIME_GATE_PROGRAM = String.raw`
import fcntl, json, os, stat, sys, time

class RuntimeGateFailure(Exception):
    def __init__(self, code): self.code = code

def runtime_fail(code): raise RuntimeGateFailure(code)

def runtime_directory(path, owner=0):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    info = os.fstat(fd)
    if info.st_uid != owner or stat.S_IMODE(info.st_mode) & 0o022:
        os.close(fd)
        runtime_fail('RUNTIME_GATE_UNSAFE')
    return fd

def runtime_file(parent, name, flags, mode=0o644, owner=0):
    fd = os.open(name, flags | os.O_NOFOLLOW | os.O_NONBLOCK, mode, dir_fd=parent)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != owner or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) & 0o022:
        os.close(fd)
        runtime_fail('RUNTIME_GATE_UNSAFE')
    return fd

def runtime_closed(parent):
    try: os.stat('closing', dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError: return False
    # Any unexpected entry fails closed, too. It is never removed by init.
    return True

def initialize_runtime(path='/var/lib/codetutor-runtime-v1', owner=0):
    try: os.mkdir(path, 0o755)
    except FileExistsError: pass
    parent = runtime_directory(path, owner)
    try:
        lock = runtime_file(parent, 'commands.lock', os.O_RDONLY | os.O_CREAT, owner=owner)
        os.close(lock)
        if runtime_closed(parent): runtime_fail('SANDBOX_CLOSING')
    finally: os.close(parent)

def acquire_command_gate(path='/var/lib/codetutor-runtime-v1', owner=0):
    parent = runtime_directory(path, owner)
    lock = None
    try:
        lock = runtime_file(parent, 'commands.lock', os.O_RDONLY, owner=owner)
        try: fcntl.flock(lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
        except BlockingIOError: runtime_fail('SANDBOX_CLOSING')
        if runtime_closed(parent): runtime_fail('SANDBOX_CLOSING')
        # The unshare supervisor inherits and holds this descriptor even if
        # learner code closes its own copy. Its death kills the PID namespace.
        os.set_inheritable(lock, True)
        return lock
    except BaseException:
        if lock is not None: os.close(lock)
        raise
    finally: os.close(parent)

def assert_runtime_open(path='/var/lib/codetutor-runtime-v1', owner=0):
    try: parent = runtime_directory(path, owner)
    except FileNotFoundError: return  # Older, source-only VMs have no commands.
    try:
        if runtime_closed(parent): runtime_fail('SANDBOX_CLOSING')
    finally: os.close(parent)
`

export const RUNTIME_INITIALIZE_PROGRAM = RUNTIME_GATE_PROGRAM + String.raw`
if __name__ == '__main__':
    try:
        initialize_runtime()
        print(json.dumps({'ready': True}))
    except RuntimeGateFailure as error:
        print(json.dumps({'error': error.code})); sys.exit(1)
    except BaseException:
        print(json.dumps({'error': 'RUNTIME_GATE_UNAVAILABLE'})); sys.exit(1)
`

export const COMMAND_GATE_PROGRAM = RUNTIME_GATE_PROGRAM + String.raw`
if __name__ == '__main__':
    try:
        lock = acquire_command_gate()
        # The executable is fixed. All learner arguments remain separate argv.
        os.execv('/usr/bin/unshare', ['/usr/bin/unshare'] + sys.argv[1:])
    except BaseException:
        print('This sandbox is closing or its command guard is unavailable.', file=sys.stderr)
        sys.exit(75)
`
