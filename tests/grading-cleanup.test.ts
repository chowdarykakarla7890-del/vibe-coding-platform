import { afterEach, beforeEach, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DSA_STATE_PROGRAM } from '@/lib/sandbox/dsa-state.mjs'

const execute = promisify(execFile)
let directory: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'codetutor-grading-cleanup-test-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

async function run(body: string) {
  // Only private fixture paths/UID and Linux process inspection are replaced.
  // No local process is signalled; real pidfd behavior is tested in a VM.
  const program = `
import os,sys,json
if sys.version_info<(3,11):raise RuntimeError('Grading cleanup tests need Python 3.11+. Set CODETUTOR_TEST_PYTHON to a compatible executable.')
scope={}
exec(${JSON.stringify(DSA_STATE_PROGRAM)},scope)
root=sys.argv[1]
scope['GRADING_ROOT']=root
scope['GRADING_OWNER']=os.getuid()
scope['grading_payload']=lambda name:root+'/payload-'+name
scope['process_start']=lambda pid:'1'
scope['record_is_alive']=lambda record:True
scope['terminate_grading_record']=lambda record:None
name='11111111-1111-4111-8111-111111111111'
other='22222222-2222-4222-8222-222222222222'
path=lambda name:'/tmp/.codetutor-grade-'+name+'.json'
register=lambda name:scope['register_grading'](path(name))
stop=lambda name:scope['stop_grading'](path(name))
finish=lambda name:scope['finish_grading'](path(name))
def seed(name):
    register(name)
    with open(root+'/payload-'+name,'w') as f:f.write('retained submission copy')
    with open(root+'/jobs/'+name+'/source.py','w') as f:f.write('grading copy')
def assert_removed(name):
    assert not os.path.lexists(root+'/jobs/'+name)
    assert not os.path.lexists(root+'/runs/'+name+'.json')
    assert not os.path.lexists(root+'/payload-'+name)
    assert os.stat(root+'/closed/'+name).st_size==0
${body}
print(json.dumps(True))
`
  const result = await execute(process.env.CODETUTOR_TEST_PYTHON ?? 'python3', ['-I', '-S', '-c', program, directory], { timeout: 10_000, maxBuffer: 4096 })
    .catch(error => { throw new Error(`Grading cleanup fixture failed:\n${String(error.stderr).slice(-2000)}`) })
  expect(JSON.parse(result.stdout)).toBe(true)
}

it('removes only one registered job and its staged copy, leaving unrelated source intact', async () => {
  await run(`
seed(name);seed(other)
with open(root+'/student-source.py','w') as f:f.write('original')
stop(name);assert_removed(name)
assert os.path.exists(root+'/jobs/'+other+'/source.py')
assert open(root+'/student-source.py').read()=='original'
assert os.stat(root+'/jobs').st_mode&0o777==0o700
`)
})

it('finishes idempotently and fences late dispatches, including before registration', async () => {
  await run(`
seed(name);finish(name);stop(name);assert_removed(name)
stop(other)
for current in [name,other]:
    with open(root+'/payload-'+current,'w') as f:f.write('late copy')
    try: register(current)
    except RuntimeError as error: assert str(error)=='GRADING_ALREADY_CLOSED'
    else: raise AssertionError('cancelled run restarted')
    assert_removed(current)
`)
})

it('rejects duplicate active registration without changing its source or record', async () => {
  await run(`
seed(name)
before=open(root+'/runs/'+name+'.json').read()
try: register(name)
except FileExistsError: pass
else: raise AssertionError('duplicate accepted')
assert open(root+'/runs/'+name+'.json').read()==before
assert os.path.exists(root+'/jobs/'+name+'/source.py')
`)
})

it('retains artifacts and metadata while process termination is unconfirmed', async () => {
  await run(`
seed(name)
def failed(record): raise RuntimeError('GRADING_STOP_UNCONFIRMED')
scope['terminate_grading_record']=failed
try: stop(name)
except RuntimeError: pass
else: raise AssertionError('unconfirmed cleanup accepted')
assert os.path.exists(root+'/jobs/'+name+'/source.py')
assert os.path.exists(root+'/runs/'+name+'.json')
scope['terminate_grading_record']=lambda record:None
stop(name);assert_removed(name)
`)
})

it('retains the record on deletion failure and completes an idempotent retry', async () => {
  await run(`
seed(name)
original=scope['shutil'].rmtree
def failed(*args,**kwargs): raise OSError('fixture failure')
failed.avoids_symlink_attacks=True
scope['shutil'].rmtree=failed
try: stop(name)
except OSError: pass
else: raise AssertionError('cleanup failure ignored')
assert os.path.exists(root+'/runs/'+name+'.json')
scope['shutil'].rmtree=original
stop(name);assert_removed(name)
`)
})

it('unlinks nested symlinks without following them outside the registered job', async () => {
  await run(`
seed(name)
os.mkdir(root+'/outside')
with open(root+'/outside/keep','w') as f:f.write('preserve')
os.symlink(root+'/outside',root+'/jobs/'+name+'/escape')
stop(name);assert_removed(name)
assert open(root+'/outside/keep').read()=='preserve'
`)
})

it.each(['job-link', 'writable-job', 'record-link', 'linked-record', 'public-state', 'extra-record-path'])('fails closed on unsafe %s state', async kind => {
  await run(`
seed(name)
kind=${JSON.stringify(kind)}
if kind=='job-link':
    os.rename(root+'/jobs/'+name,root+'/keep')
    os.symlink(root+'/keep',root+'/jobs/'+name)
elif kind=='writable-job':os.chmod(root+'/jobs/'+name,0o777)
elif kind=='record-link':
    os.rename(root+'/runs/'+name+'.json',root+'/keep-record')
    os.symlink(root+'/keep-record',root+'/runs/'+name+'.json')
elif kind=='linked-record':os.link(root+'/runs/'+name+'.json',root+'/keep-record')
elif kind=='public-state':os.chmod(root+'/jobs',0o755)
else:
    with open(root+'/runs/'+name+'.json','w') as f:json.dump({'pid':99,'start':'1','path':'/unrelated'},f)
try:stop(name)
except (OSError,RuntimeError,ValueError,scope['RuntimeGateFailure']):pass
else:raise AssertionError('unsafe cleanup accepted')
assert os.path.lexists(root+'/runs/'+name+'.json')
`)
})

it('reclaims dead registered jobs on next launch but preserves live jobs', async () => {
  await run(`
seed(name)
scope['record_is_alive']=lambda record:False
register(other)
assert_removed(name)
scope['record_is_alive']=lambda record:True
with scope['grading_state']() as state:scope['reap_grading_artifacts'](state)
assert os.path.exists(root+'/jobs/'+other)
`)
})

it('bounds each reaper pass and never scans arbitrary temporary directories', async () => {
  await run(`
names=[]
for index in range(40):
    current=str(index).zfill(36);names.append(current);seed(current)
scope['record_is_alive']=lambda record:False
with scope['grading_state']() as state:scope['reap_grading_artifacts'](state)
assert len(os.listdir(root+'/runs'))==8
with scope['grading_state']() as state:scope['reap_grading_artifacts'](state)
assert not os.listdir(root+'/runs')
`)
})

it('does not delete artifacts after an uncertain process lookup', async () => {
  await run(`
seed(name)
def unavailable(record):raise PermissionError('unknown process state')
scope['record_is_alive']=unavailable
try:register(other)
except PermissionError:pass
else:raise AssertionError('unknown process state ignored')
assert os.path.exists(root+'/jobs/'+name+'/source.py')
`)
})

it('recovers a partially written registration without trusting truncated JSON', async () => {
  await run(`
with scope['grading_state']() as state:
    fd=os.open(name+'.pending',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600,dir_fd=state[0])
    os.write(fd,b'{"pid":');os.close(fd)
with open(root+'/payload-'+name,'w') as f:f.write('staged source')
register(other)
assert_removed(name)
assert not os.path.exists(root+'/runs/'+name+'.pending')
`)
})

it('bounds lock contention without cleaning a concurrently managed run', async () => {
  await run(`
seed(name)
with scope['grading_state']():
    clock=iter([0,3])
    scope['time'].monotonic=lambda:next(clock)
    try:stop(name)
    except RuntimeError as error:assert str(error)=='GRADING_CONTROL_BUSY'
    else:raise AssertionError('concurrent control lock ignored')
assert os.path.exists(root+'/jobs/'+name+'/source.py')
`)
})

it('reclaims uploads arriving after Stop fairly across more than one cleanup batch', async () => {
  await run(`
names=[str(index).zfill(36) for index in range(70)]
for current in names:stop(current)
for current in names:
    with open(root+'/payload-'+current,'w') as f:f.write('late upload')
for batch in range(3):
    with scope['grading_state']() as state:scope['reap_grading_artifacts'](state)
assert not [name for name in os.listdir(root) if name.startswith('payload-')]
`)
})

it('does not sweep a closed marker whose supervisor is still alive', async () => {
  await run(`
seed(name)
with scope['grading_state']() as state:
    scope['mark_grading_closed'](state[2],name)
    scope['reap_grading_artifacts'](state)
try:register(name)
except RuntimeError as error:assert str(error)=='GRADING_ALREADY_CLOSED'
else:raise AssertionError('closed live run relaunched')
assert os.path.exists(root+'/jobs/'+name+'/source.py')
assert os.path.exists(root+'/payload-'+name)
`)
})
