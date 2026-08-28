import { DSA_STATE_PROGRAM } from './dsa-state.mjs'

// Only this fixed supervisor runs privileged. Submitted code and compilers
// run as nobody in a fresh network/PID namespace with no privilege escalation.
// Expected answers and scoring never enter the VM.
export const DSA_RUNNER_PROGRAM = DSA_STATE_PROGRAM + String.raw`
import hashlib, resource, selectors, subprocess

def emit(value): print(json.dumps(value, ensure_ascii=True), flush=True)

NAMESPACE_PROGRAM = r'''
import os, subprocess, sys
root=sys.argv[1]
def mount(args): subprocess.run(['/usr/bin/mount']+args,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
mount(['--make-rprivate','/'])
for path in ['/usr/bin','/usr/lib','/usr/lib64','/usr/libexec','/usr/share','/usr/include','/etc']:
    if not os.path.isdir(path): continue
    target=root+path; os.makedirs(target,exist_ok=True)
    mount(['--bind',path,target]); mount(['-o','remount,bind,ro,nosuid,nodev',target])
for name in ['bin','lib','lib64']:
    target='/usr/'+name
    if os.path.isdir(target) and not os.path.lexists(root+'/'+name): os.symlink(target,root+'/'+name)
os.makedirs(root+'/work',exist_ok=True)
mount(['--bind',os.path.join(os.path.dirname(root),'work'),root+'/work'])
os.makedirs(root+'/proc',exist_ok=True); mount(['-t','proc','proc',root+'/proc'])
os.makedirs(root+'/dev',exist_ok=True)
for name in ['null','zero','urandom','random']:
    target=root+'/dev/'+name
    if not os.path.exists(target): open(target,'a').close()
    mount(['--bind','/dev/'+name,target])
os.makedirs(root+'/tmp',exist_ok=True); os.chmod(root+'/tmp',0o1777)
os.chroot(root); os.chdir('/work/build')
os.execv('/usr/bin/setpriv',['setpriv','--reuid=65534','--regid=65534','--clear-groups','--no-new-privs',
    '--bounding-set=-all','--inh-caps=-all','--ambient-caps=-all','--']+sys.argv[2:])
'''

def executable(name):
    path = '/var/lib/codetutor-grading-v1/node' if name=='node' else shutil.which(name, path='/usr/bin:/bin')
    if path and not os.path.isfile(path): path=None
    if not path: raise RuntimeError('GRADING_TOOLCHAIN_UNAVAILABLE')
    info = os.stat(path)
    if info.st_uid != 0 or stat.S_IMODE(info.st_mode) & 0o022: raise RuntimeError('GRADING_TOOLCHAIN_UNSAFE')
    parent=os.path.dirname(os.path.realpath(path))
    while parent!='/':
        info=os.stat(parent)
        if info.st_uid!=0 or stat.S_IMODE(info.st_mode)&0o022: raise RuntimeError('GRADING_TOOLCHAIN_UNSAFE')
        parent=os.path.dirname(parent)
    return '/opt/node' if name=='node' else path

def limits():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_FSIZE, (4*1024*1024, 4*1024*1024))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))
    resource.setrlimit(resource.RLIMIT_CPU, (10, 10))

def validate_inputs(inputs):
    if not isinstance(inputs,list) or not 1<=len(inputs)<=24: raise RuntimeError('GRADING_PAYLOAD_INVALID')
    for text in inputs:
        try:
            if not isinstance(text,str) or len(text.encode('utf8'))>65536: raise RuntimeError('GRADING_PAYLOAD_INVALID')
        except UnicodeError: raise RuntimeError('GRADING_PAYLOAD_INVALID')

def run(argv, root, input_text, seconds, output_limit=2048):
    # All namespace/privilege arguments are trusted constants, never submitted
    # commands. The root supervisor owns pipes and results, not the learner UID.
    command = ['/usr/bin/unshare', '--mount', '--net', '--pid', '--fork', '--kill-child=KILL', '--',
      '/usr/bin/python3', '-I', '-S', '-c', NAMESPACE_PROGRAM, root] + argv
    child = subprocess.Popen(command, cwd='/', env={'PATH':'/usr/bin:/bin','HOME':'/work/build','LANG':'C.UTF-8','UV_THREADPOOL_SIZE':'1'},
      stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, close_fds=True, start_new_session=True, preexec_fn=limits)
    selector = selectors.DefaultSelector()
    output = bytearray(); count = 0; failure = None; end = time.monotonic()+seconds
    try:
        # Feeding stdin synchronously can block before the deadline/output
        # checks when a submitted program never reads, or writes first. Keep
        # all three pipes in the same bounded loop, handling partial writes.
        pending=memoryview(input_text.encode('utf8'))
        os.set_blocking(child.stdin.fileno(),False)
        if pending: selector.register(child.stdin,selectors.EVENT_WRITE,'in')
        else: child.stdin.close()
        selector.register(child.stdout, selectors.EVENT_READ, 'out'); selector.register(child.stderr, selectors.EVENT_READ, 'err')
        while selector.get_map():
            if time.monotonic() >= end: failure='timeout'; break
            for key, _ in selector.select(min(0.05, max(0, end-time.monotonic()))):
                if key.data=='in':
                    try: pending=pending[os.write(key.fileobj.fileno(),pending[:4096]):]
                    except BlockingIOError: continue
                    except BrokenPipeError: pending=pending[:0]
                    if not pending: selector.unregister(key.fileobj); key.fileobj.close()
                    continue
                chunk = os.read(key.fileobj.fileno(), 4096)
                if not chunk: selector.unregister(key.fileobj); key.fileobj.close(); continue
                count += len(chunk)
                if count > output_limit: failure='output-limit'; break
                if key.data == 'out': output.extend(chunk)
            if failure: break
        if not failure:
            try:
                if child.wait(timeout=max(0.01,end-time.monotonic())) != 0: failure='execution-error'
            except subprocess.TimeoutExpired: failure='timeout'
        return {'output': output.decode('utf8', errors='strict') if not failure else '', 'failure': failure}
    except (UnicodeError, BrokenPipeError): return {'output':'', 'failure':'invalid-output'}
    finally:
        # Killing the unshare parent kills its whole PID namespace, including
        # daemonized descendants that left the process group.
        if child.poll() is None:
            child.kill()
        try: child.wait(timeout=2)
        except subprocess.TimeoutExpired: pass
        selector.close()
        for stream in [child.stdin, child.stdout, child.stderr]:
            if not stream.closed: stream.close()

def main(payload_path, digest):
    if not re.fullmatch(r'/tmp/\.codetutor-grade-[a-f0-9-]{36}\.json', payload_path): raise RuntimeError('GRADING_PAYLOAD_INVALID')
    fd = os.open(payload_path, os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    with os.fdopen(fd,'rb') as file:
        info=os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size>2097152: raise RuntimeError('GRADING_PAYLOAD_INVALID')
        raw=file.read(2097153)
    if len(raw)>2097152 or hashlib.sha256(raw).hexdigest()!=digest: raise RuntimeError('GRADING_PAYLOAD_CHANGED')
    data=json.loads(raw)
    if set(data)!=set(['files','inputs','language']): raise RuntimeError('GRADING_PAYLOAD_INVALID')
    validate_inputs(data['inputs'])
    if len(data['files'])>3: raise RuntimeError('GRADING_PAYLOAD_INVALID')
    initialize_runtime()
    parent=runtime_directory('/var/lib/codetutor-runtime-v1')
    lock=runtime_file(parent,'commands.lock',os.O_RDONLY)
    try:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        if runtime_closed(parent): raise RuntimeError('SANDBOX_CLOSING')
    except BlockingIOError: raise RuntimeError('GRADING_WORKSPACE_BUSY')
    finally: os.close(parent)
    # No grader shares mutable files with the editor, package scripts or any
    # other submission. root owns source/harness; only build/ is writable.
    directory=GRADING_ROOT+'/jobs/'+grading_id(payload_path)
    os.close(runtime_directory(directory))
    try:
        work=directory+'/work'; os.mkdir(work,0o755)
        root=directory+'/root'; os.mkdir(root,0o755); os.mkdir(root+'/opt',0o755)
        if data['language'] in ['JavaScript','TypeScript']:
            executable('node')
            shutil.copyfile('/var/lib/codetutor-grading-v1/node',root+'/opt/node'); os.chmod(root+'/opt/node',0o555)
        for file in data['files']:
            if not re.fullmatch(r'[A-Za-z][A-Za-z0-9_.]{0,40}',file['path']): raise RuntimeError('GRADING_PAYLOAD_INVALID')
            target=os.path.join(work,file['path'])
            with open(target,'x',encoding='utf8') as out: out.write(file['content'])
            os.chmod(target,0o444)
        build='/work/build'; os.mkdir(work+'/build',0o700); os.chown(work+'/build',65534,65534)
        lang=data['language']; compile_command=None
        if lang in ['JavaScript','TypeScript']:
            argv=[executable('node'),'--max-old-space-size=64','--v8-pool-size=1','/work/runner.mjs']
        elif lang=='Python': argv=[executable('python3'),'-I','-S','/work/runner.py']
        elif lang=='Java':
            compile_command=[executable('javac'),'-J-Xmx64m','-J-XX:ActiveProcessorCount=1','-d',build,'/work/Main.java','/work/Runner.java']
            argv=[executable('java'),'-Xmx64m','-XX:ActiveProcessorCount=1','-cp',build,'Runner']
        elif lang=='C++':
            compile_command=[executable('g++'),'-std=c++17','-O0','/work/runner.cpp','-o',os.path.join(build,'solve')]
            argv=[os.path.join(build,'solve')]
        else: raise RuntimeError('GRADING_PAYLOAD_INVALID')
        probe=run(['/usr/bin/true'],root,'',1)
        if probe['failure']: raise RuntimeError('GRADING_ISOLATION_UNAVAILABLE')
        if compile_command:
            compilation=run(compile_command,root,'',10,8192)
            if compilation['failure']:
                emit({'compileFailure':compilation['failure'],'cases':[]}); return
        results=[]
        for text in data['inputs']:
            results.append(run(argv,root,text,1.5))
        emit({'compileFailure':None,'cases':results})
    finally:
        os.close(lock)

try:
    main(sys.argv[1],sys.argv[2])
except BaseException as error:
    code=str(error) if isinstance(error,RuntimeError) and re.fullmatch(r'[A-Z_]{5,80}',str(error)) else 'GRADING_RUNTIME_UNAVAILABLE'
    emit({'error':code}); sys.exit(1)
finally:
    if len(sys.argv)>1 and re.fullmatch(r'/tmp/\.codetutor-grade-[a-f0-9-]{36}\.json',sys.argv[1]):
        finish_grading(sys.argv[1])
`
