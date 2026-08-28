import { expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DSA_RUNNER_PROGRAM } from '@/lib/sandbox/dsa-program.mjs'

const execute = promisify(execFile)

async function fixture(body: string) {
  // Execute the real I/O functions with real local pipes. Only the Linux
  // namespace launch and privilege/resource setup are replaced; isolation is
  // covered separately by the opt-in Linux VM suite. No unrelated PID is used.
  const program = `
import ast,json,os,selectors,subprocess,sys,time
tree=ast.parse(${JSON.stringify(DSA_RUNNER_PROGRAM)})
functions=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in ['run','validate_inputs']]
scope=dict(os=os,selectors=selectors,subprocess=subprocess,time=time,NAMESPACE_PROGRAM='',limits=lambda:None)
exec(compile(ast.Module(body=functions,type_ignores=[]),'grading-io','exec'),scope)
original=subprocess.Popen
children=[]
def launch(command,**kwargs):
    child=original(command[command.index('TEST_ROOT')+1:],**kwargs)
    children.append(child)
    return child
subprocess.Popen=launch
def run(source,text='',seconds=.3,output_limit=2048):
    return scope['run']([sys.executable,'-I','-S','-c',source],'TEST_ROOT',text,seconds,output_limit)
${body}
assert all(child.poll() is not None for child in children)
assert all(stream.closed for child in children for stream in [child.stdin,child.stdout,child.stderr])
print(json.dumps(True))
`
  const result = await execute(process.env.CODETUTOR_TEST_PYTHON ?? 'python3', ['-I', '-S', '-c', program], { timeout: 2500, maxBuffer: 4096 })
    .catch(error => { throw new Error(error.killed ? 'Grading I/O failed to enforce its deadline' : `Grading I/O fixture failed: ${String(error.stderr).slice(-1500)}`) })
  expect(JSON.parse(result.stdout)).toBe(true)
}

it('accepts bounded UTF-8 inputs up to 64 KiB, rejecting invalid types, counts and oversized bytes', async () => {
  await fixture(`
validate=scope['validate_inputs']
validate(['x'*65536]*24)
validate(['é'*32768])
for value in [[],['']*25,'not a list',{},[None],[1],['x'*65537],['é'*32769],['\\ud800']]:
    try:validate(value)
    except RuntimeError as error:assert str(error)=='GRADING_PAYLOAD_INVALID'
    else:raise AssertionError('invalid input accepted')
`)
})

it('times out a program that never consumes a pipe-sized input and reaps it', async () => {
  // macOS grows pipe buffers beyond Linux defaults. Exercise the transport
  // with 1 MiB to force backpressure on either OS; public input admission is
  // independently capped at 64 KiB by validate_inputs above.
  await fixture(`
started=time.monotonic()
assert run('import time;time.sleep(10)','x'*1048576)=={'output':'','failure':'timeout'}
assert time.monotonic()-started<2
`)
})

it('delivers complete large Unicode input without truncation or duplicated bytes', async () => {
  await fixture(`
text='abé😀'*8192
result=run('import sys,hashlib;print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())',text,1)
import hashlib
assert result=={'output':hashlib.sha256(text.encode('utf8')).hexdigest()+'\\n','failure':None}
`)
})

it('drains output while supplying input instead of deadlocking full pipes', async () => {
  await fixture(`
source='import sys;sys.stdout.write("y"*1048576);sys.stdout.flush();print(len(sys.stdin.buffer.read()))'
assert run(source,'x'*1048576,1,1050000)=={'output':'y'*1048576+'1048576\\n','failure':None}
`)
})

it('retains bounded output and process status when a child closes stdin early', async () => {
  await fixture(`
assert run('import os;os.close(0);print("done")','x'*1048576,1)=={'output':'done\\n','failure':None}
assert run('import os;os.close(0);raise SystemExit(3)','x'*1048576,1)=={'output':'','failure':'execution-error'}
`)
})

it('enforces combined output limits while input is blocked and on malformed output', async () => {
  await fixture(`
assert run('import sys,time;sys.stderr.write("x"*4096);sys.stderr.flush();time.sleep(10)','x'*1048576)['failure']=='output-limit'
assert run('import os;os.write(1,bytes([255]))','')['failure']=='invalid-output'
`)
})

it('bounds process completion even after both output descriptors close', async () => {
  await fixture(`
assert run('import os,time;os.close(1);os.close(2);time.sleep(10)','')['failure']=='timeout'
`)
})
