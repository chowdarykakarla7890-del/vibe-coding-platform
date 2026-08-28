import { RUNTIME_GATE_PROGRAM } from './runtime-programs.mjs'

// Only fixed privileged programs use this state. Cleanup targets derive from
// a validated run ID under a private root, never source or an arbitrary path.
export const DSA_STATE_PROGRAM = RUNTIME_GATE_PROGRAM + String.raw`
import contextlib, re, select, shutil, signal

GRADING_ROOT='/var/lib/codetutor-grading-v1'
GRADING_OWNER=0

def grading_id(path):
    match=re.fullmatch(r'/tmp/\.codetutor-grade-([a-f0-9-]{36})\.json',path)
    if not match: raise ValueError('Invalid grading reference')
    return match.group(1)

def grading_payload(name): return '/tmp/.codetutor-grade-'+name+'.json'

@contextlib.contextmanager
def grading_state():
    parent=runtime_directory(GRADING_ROOT,GRADING_OWNER)
    handles=[]
    try:
        lock=runtime_file(parent,'control.lock',os.O_RDONLY|os.O_CREAT,0o600,GRADING_OWNER)
        handles.append(lock)
        end=time.monotonic()+2
        while True:
            try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB); break
            except BlockingIOError:
                if time.monotonic()>=end: raise RuntimeError('GRADING_CONTROL_BUSY')
                time.sleep(0.01)
        for name in ['runs','jobs','closed']:
            try: os.mkdir(name,0o700,dir_fd=parent)
            except FileExistsError: pass
            fd=runtime_directory(GRADING_ROOT+'/'+name,GRADING_OWNER)
            if stat.S_IMODE(os.fstat(fd).st_mode)&0o077:
                os.close(fd); raise RuntimeError('GRADING_CONTROL_UNSAFE')
            handles.append(fd)
        yield tuple(handles[1:])
    finally:
        for fd in reversed(handles): os.close(fd)
        os.close(parent)

def process_start(pid):
    with open('/proc/'+str(pid)+'/stat') as file:
        return file.read().rsplit(')',1)[1].split()[19]

def record_is_alive(record):
    try:
        return process_start(record['pid'])==record['start'] and os.stat('/proc/'+str(record['pid'])).st_uid==GRADING_OWNER
    except (ProcessLookupError,FileNotFoundError): return False

def read_grading_record(records,name):
    try: fd=runtime_file(records,name+'.json',os.O_RDONLY,owner=GRADING_OWNER)
    except FileNotFoundError: return None
    with os.fdopen(fd) as file: record=json.loads(file.read(512))
    if set(record)!=set(['pid','start']) or type(record['pid']) is not int or record['pid']<=1 or not isinstance(record['start'],str) or not re.fullmatch(r'[0-9]+',record['start']):
        raise ValueError('Invalid process record')
    return record

def mark_grading_closed(closed,name):
    # Zero-byte tombstones remain until VM expiration: a delayed dispatch
    # cannot recreate a run after a stop/completion receipt.
    fd=runtime_file(closed,name,os.O_RDONLY|os.O_CREAT,0o600,GRADING_OWNER)
    os.close(fd)

def remove_grading_artifacts(state,name):
    records,jobs,closed=state
    if not re.fullmatch(r'[a-f0-9-]{36}',name): raise ValueError('Invalid run ID')
    mark_grading_closed(closed,name)
    try: info=os.stat(name,dir_fd=jobs,follow_symlinks=False)
    except FileNotFoundError: info=None
    if info is not None:
        if not stat.S_ISDIR(info.st_mode) or info.st_uid!=GRADING_OWNER or stat.S_IMODE(info.st_mode)&0o022:
            raise RuntimeError('GRADING_SCRATCH_UNSAFE')
        if not shutil.rmtree.avoids_symlink_attacks: raise RuntimeError('GRADING_CLEANUP_UNAVAILABLE')
        # fd-relative deletion unlinks nested symlinks, never their targets.
        # Failure retains the process record for an idempotent retry.
        shutil.rmtree(name,dir_fd=jobs)
    try: os.unlink(grading_payload(name))
    except FileNotFoundError: pass
    try: os.unlink(name+'.json',dir_fd=records)
    except FileNotFoundError: pass
    try: os.unlink(name+'.pending',dir_fd=records)
    except FileNotFoundError: pass

def terminate_grading_record(record):
    try: pidfd=os.pidfd_open(record['pid'])
    except ProcessLookupError: return
    try:
        if not record_is_alive(record): return
        signal.pidfd_send_signal(pidfd,signal.SIGKILL)
        poll=select.poll(); poll.register(pidfd,select.POLLIN)
        if not poll.poll(2000): raise RuntimeError('GRADING_STOP_UNCONFIRMED')
    finally: os.close(pidfd)

def reap_grading_artifacts(state):
    # Bounded recovery of externally killed supervisors or lost stop requests.
    # This never signals a process; uncertain state fails closed.
    records,_,_=state
    for filename in sorted(os.listdir(records))[:32]:
        match=re.fullmatch(r'([a-f0-9-]{36})\.(json|pending)',filename)
        if not match: continue
        name=match.group(1)
        # Registration holds the same lock until publication/exec handoff.
        # A pending entry observed here belongs to an interrupted registration.
        if match.group(2)=='pending':
            remove_grading_artifacts(state,name); continue
        record=read_grading_record(records,name)
        if record is not None and not record_is_alive(record): remove_grading_artifacts(state,name)
    # An upload acknowledgement can be lost before a process is registered.
    # Revisit closed IDs fairly, so a payload arriving after Stop is reclaimed
    # without scanning or deleting unrelated files under /tmp.
    _,_,closed=state
    names=sorted(name for name in os.listdir(closed) if re.fullmatch(r'[a-f0-9-]{36}',name))
    cursor=runtime_file(closed,'sweep.cursor',os.O_RDWR|os.O_CREAT,0o600,GRADING_OWNER)
    try:
        last=os.read(cursor,64).decode('ascii')
        if last and not re.fullmatch(r'[a-f0-9-]{36}',last): last=''
        batch=([name for name in names if name>last]+[name for name in names if name<=last])[:32]
        for name in batch:
            record=read_grading_record(records,name)
            if record is None or not record_is_alive(record): remove_grading_artifacts(state,name)
        if batch:
            os.lseek(cursor,0,os.SEEK_SET);os.write(cursor,batch[-1].encode('ascii'));os.ftruncate(cursor,36)
    finally:os.close(cursor)

def register_grading(path):
    name=grading_id(path)
    with grading_state() as state:
        records,jobs,closed=state
        reap_grading_artifacts(state)
        try: os.stat(name,dir_fd=closed,follow_symlinks=False)
        except FileNotFoundError: pass
        else:
            record=read_grading_record(records,name)
            if record is None or not record_is_alive(record): remove_grading_artifacts(state,name)
            raise RuntimeError('GRADING_ALREADY_CLOSED')
        # An active duplicate cannot replace its process record or workspace.
        if read_grading_record(records,name) is not None: raise FileExistsError('Grading run exists')
        fd=runtime_file(records,name+'.pending',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600,GRADING_OWNER)
        with os.fdopen(fd,'w') as file:
            json.dump({'pid':os.getpid(),'start':process_start(os.getpid())},file)
        os.rename(name+'.pending',name+'.json',src_dir_fd=records,dst_dir_fd=records)
        os.mkdir(name,0o700,dir_fd=jobs)

def finish_grading(path):
    with grading_state() as state: remove_grading_artifacts(state,grading_id(path))

def stop_grading(path):
    name=grading_id(path)
    with grading_state() as state:
        records,_,closed=state
        mark_grading_closed(closed,name)
        record=read_grading_record(records,name)
        if record is not None: terminate_grading_record(record)
        remove_grading_artifacts(state,name)
`
