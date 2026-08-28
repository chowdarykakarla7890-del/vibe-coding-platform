import { expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as pause } from 'node:timers/promises'
import { Sandbox } from '@vercel/sandbox'
import { getSandboxCredentials } from '@/ai/sandbox'
import { prepareDSARuntime } from '@/lib/sandbox/dsa-runtime'
import { stopDSAGrading, trustedDSACommand } from '@/lib/sandbox/dsa-invocation'
import { dsaPayload } from '@/lib/server/dsa-grading'
import { dsaCases } from '@/lib/server/dsa-cases'
import { guardedCommand } from '@/lib/server/command-guard'
import { captureCommandOutput } from '@/lib/server/command-execution'

vi.mock('server-only', () => ({}))

it.skipIf(process.env.RUN_LIVE_DSA_CANCELLATION !== '1')('terminates the privileged supervisor and its unprivileged grading tree', async () => {
  const name = `codetutor-grading-cancel-${randomUUID()}`
  let sandbox: Sandbox | undefined
  try {
    sandbox = await Sandbox.create({ name, ...getSandboxCredentials(), timeout: 120_000, persistent: false, signal: AbortSignal.timeout(45_000) })
    const vm = sandbox.currentSession()
    try {
    await prepareDSARuntime(vm, 'JavaScript')
    const payload = JSON.stringify(dsaPayload('dsa-python-two-sum', 'JavaScript', 'export function solve(){while(true){}}', dsaCases('dsa-python-two-sum')))
    const path = `/tmp/.codetutor-grade-${randomUUID()}.json`
    const sentinel = `${vm.cwd}/student-source-preserved.txt`
    await vm.writeFiles([{ path: sentinel, content: 'Unrelated student source must survive grading cleanup.' }], { signal: AbortSignal.timeout(5000) })
    await vm.writeFiles([{ path, content: payload }], { signal: AbortSignal.timeout(5000) })
    const command = await vm.runCommand({ ...trustedDSACommand(path, createHash('sha256').update(payload).digest('hex')), detached: true, timeoutMs: 60_000, signal: AbortSignal.timeout(10_000) })
    await vi.waitFor(async () => {
      const guest = await vm.runCommand({ cmd: '/usr/bin/pgrep', args: ['-u', '65534'], sudo: true, timeoutMs: 2000, signal: AbortSignal.timeout(5000) })
      expect(guest.exitCode, 'wait for learner code before testing cancellation').toBe(0)
    }, { timeout: 10_000, interval: 100 })
    const start = Date.now()
    await stopDSAGrading(vm, path, AbortSignal.timeout(5000))
    const result = await command.wait({ signal: AbortSignal.timeout(5000) })
    expect(Number.isInteger(result.exitCode)).toBe(true)
    expect(result.exitCode).not.toBe(0)
    const guests = await vm.runCommand({ cmd: '/usr/bin/pgrep', args: ['-u', '65534'], sudo: true, timeoutMs: 2000, signal: AbortSignal.timeout(5000) })
    expect(guests.exitCode).toBe(1)
    expect(await vm.readFileToBuffer({ path }, { signal: AbortSignal.timeout(5000) }) === null, 'interrupted grading removes its staged source payload').toBe(true)
    const artifacts = await vm.runCommand({ cmd: '/usr/bin/python3', args: ['-I', '-S', '-c',
      'import os\nassert not os.listdir("/var/lib/codetutor-grading-v1/jobs")\nassert not [name for name in os.listdir("/tmp") if name.startswith("codetutor-grade-")]'],
      sudo: true, timeoutMs: 2000, signal: AbortSignal.timeout(5000) })
    expect(artifacts.exitCode, 'interrupted grading leaves no scratch source or copied runtime').toBe(0)
    expect((await vm.readFileToBuffer({ path: sentinel }, { signal: AbortSignal.timeout(5000) }))?.toString()).toBe('Unrelated student source must survive grading cleanup.')
    await stopDSAGrading(vm, path, AbortSignal.timeout(5000))
    console.log('PASS: registered supervisor termination leaves no grading processes', { durationMs: Date.now() - start })

    // Stop can reach the VM before a delayed launch. A tombstone must prevent
    // that launch and remove even a payload that arrived after the first Stop.
    const latePath = `/tmp/.codetutor-grade-${randomUUID()}.json`
    await stopDSAGrading(vm, latePath, AbortSignal.timeout(5000))
    await vm.writeFiles([{ path: latePath, content: payload }], { signal: AbortSignal.timeout(5000) })
    const late = await vm.runCommand({ ...trustedDSACommand(latePath, createHash('sha256').update(payload).digest('hex')), timeoutMs: 5000, signal: AbortSignal.timeout(8000) })
    expect(late.exitCode, 'late cancelled dispatch is rejected').toBe(75)
    expect(await vm.readFileToBuffer({ path: latePath }, { signal: AbortSignal.timeout(5000) }) === null).toBe(true)

    // Simulate a host supervisor killed outside the application Stop path.
    // Its next registered run must reclaim only the orphan's private files.
    const orphanId = randomUUID(), orphanPath = `/tmp/.codetutor-grade-${orphanId}.json`
    await vm.writeFiles([{ path: orphanPath, content: payload }], { signal: AbortSignal.timeout(5000) })
    const orphan = await vm.runCommand({ ...trustedDSACommand(orphanPath, createHash('sha256').update(payload).digest('hex')), detached: true, timeoutMs: 60_000, signal: AbortSignal.timeout(5000) })
    await vi.waitFor(async () => {
      const guest = await vm.runCommand({ cmd: '/usr/bin/pgrep', args: ['-u', '65534'], sudo: true, timeoutMs: 2000, signal: AbortSignal.timeout(5000) })
      expect(guest.exitCode).toBe(0)
    }, { timeout: 10_000, interval: 100 })
    const killed = await vm.runCommand({ cmd: '/usr/bin/python3', args: ['-I', '-S', '-c',
      'import json,os,signal,sys\nwith open("/var/lib/codetutor-grading-v1/runs/"+sys.argv[1]+".json") as f:record=json.load(f)\nsignal.pidfd_send_signal(os.pidfd_open(record["pid"]),signal.SIGKILL)', orphanId],
      sudo: true, timeoutMs: 2000, signal: AbortSignal.timeout(5000) })
    expect(killed.exitCode).toBe(0)
    await orphan.wait({ signal: AbortSignal.timeout(5000) })
    const nextPath = `/tmp/.codetutor-grade-${randomUUID()}.json`
    const nextPayload = JSON.stringify(dsaPayload('dsa-python-two-sum', 'JavaScript', 'export function solve(){return []}', [{ input: { nums: [], target: 0 }, label: 'empty' }]))
    await vm.writeFiles([{ path: nextPath, content: nextPayload }], { signal: AbortSignal.timeout(5000) })
    const next = await vm.runCommand({ ...trustedDSACommand(nextPath, createHash('sha256').update(nextPayload).digest('hex')), detached: true, timeoutMs: 60_000, signal: AbortSignal.timeout(5000) })
    const nextResult = await captureCommandOutput(next, AbortSignal.timeout(10_000), 'base64-v1')
    expect(nextResult.exitCode).toBe(0)
    expect(JSON.parse(nextResult.output)).toMatchObject({ compileFailure: null, cases: [{ output: '[]', failure: null }] })
    for (const cleanedPath of [orphanPath, nextPath]) expect(await vm.readFileToBuffer({ path: cleanedPath }, { signal: AbortSignal.timeout(5000) }) === null).toBe(true)
    const clean = await vm.runCommand({ cmd: '/usr/bin/python3', args: ['-I', '-S', '-c',
      'import os\nassert not os.listdir("/var/lib/codetutor-grading-v1/jobs")\nassert not os.listdir("/var/lib/codetutor-grading-v1/runs")'],
      sudo: true, timeoutMs: 2000, signal: AbortSignal.timeout(5000) })
    expect(clean.exitCode, 'normal completion and orphan recovery leave no source artifacts or active records').toBe(0)
    console.log('PASS: late-launch fencing, external-kill reclamation, normal completion and source preservation.')

    // A disposable, root-owned sleeper is our unrelated-process target. Give
    // it a correct cleanup reference and a deliberately stale reference. The
    // latter must neither signal the process nor be editable by learner UID.
    const validId = randomUUID(), staleId = randomUUID()
    const root = '/var/lib/codetutor-grading-v1/runs/'
    const fixture = String.raw`import json,os,sys,time
root='/var/lib/codetutor-grading-v1/runs/'
with open('/proc/self/stat') as file: start=file.read().rsplit(')',1)[1].split()[19]
for name,stamp in [(sys.argv[1],start),(sys.argv[2],'0')]:
    fd=os.open(root+name+'.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as file: json.dump({'pid':os.getpid(),'start':stamp},file)
job='/var/lib/codetutor-grading-v1/jobs/'+sys.argv[1]
os.mkdir(job,0o700)
with open(job+'/keep','w') as file:file.write('Still owned by the live supervisor')
fd=os.open('/var/lib/codetutor-grading-v1/closed/'+sys.argv[1],os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
os.close(fd)
time.sleep(60)
`
    const sleeper = await vm.runCommand({ cmd: '/usr/bin/python3', args: ['-I', '-S', '-c', fixture, validId, staleId], sudo: true, detached: true, timeoutMs: 65_000, signal: AbortSignal.timeout(5000) })
    try {
      await vi.waitFor(async () => {
        const exists = await vm.runCommand({ cmd: '/usr/bin/test', args: ['-e', `${root}${staleId}.json`], sudo: true, timeoutMs: 2000, signal: AbortSignal.timeout(5000) })
        expect(exists.exitCode).toBe(0)
      }, { timeout: 5000, interval: 100 })
      // Exercise the real learner execution boundary: raw SDK commands are
      // platform management operations, not the privilege-dropped terminal.
      const denied = await vm.runCommand({ ...guardedCommand('/usr/bin/python3', ['-I', '-S', '-c', String.raw`import os,sys
assert os.geteuid()!=0
for mode in ['r','w']:
    try:
        with open(sys.argv[1],mode): pass
    except PermissionError: continue
    raise RuntimeError('Learner could access a process record')
`, `${root}${validId}.json`]), timeoutMs: 2000, signal: AbortSignal.timeout(5000) })
      expect(denied.exitCode, `learner UID cannot read or overwrite the root record: ${await denied.stderr({signal:AbortSignal.timeout(5000)})}`).toBe(0)
      await stopDSAGrading(vm, `/tmp/.codetutor-grade-${staleId}.json`, AbortSignal.timeout(5000))
      await pause(50)
      const alive = await vm.runCommand({ cmd: '/usr/bin/python3', args: ['-I', '-S', '-c', 'import json,os,sys\nwith open(sys.argv[1]) as f: record=json.load(f)\nos.kill(record["pid"],0)', `${root}${validId}.json`], sudo: true, timeoutMs: 2000, signal: AbortSignal.timeout(5000) })
      expect(alive.exitCode, 'a stale process start time cannot kill an unrelated live process').toBe(0)
      const fenced = await vm.runCommand({ ...trustedDSACommand(`/tmp/.codetutor-grade-${validId}.json`, 'a'.repeat(64)), timeoutMs: 5000, signal: AbortSignal.timeout(8000) })
      expect(fenced.exitCode).toBe(75)
      const preserved = await vm.runCommand({ cmd: '/usr/bin/test', args: ['-f', `/var/lib/codetutor-grading-v1/jobs/${validId}/keep`], sudo: true, timeoutMs: 2000, signal: AbortSignal.timeout(5000) })
      expect(preserved.exitCode, 'a closed marker does not permit a duplicate launch to delete a still-live job').toBe(0)
    } finally {
      await stopDSAGrading(vm, `/tmp/.codetutor-grade-${validId}.json`, AbortSignal.timeout(5000))
      await sleeper.wait({ signal: AbortSignal.timeout(5000) })
    }
    console.log('PASS: private process records and stale-PID stop isolation.')
    } catch (error) {
    const processes = await vm.runCommand({ cmd: '/usr/bin/ps', args: ['-eo', 'pid,ppid,uid,comm'], sudo: true, timeoutMs: 2000, signal: AbortSignal.timeout(5000) })
    console.log('Disposable VM process identities (no arguments or environment)', await processes.stdout({ signal: AbortSignal.timeout(5000) }))
    throw error
    }
  } finally {
    const cleanup = sandbox ?? await Sandbox.get({ name, resume: false, ...getSandboxCredentials(), signal: AbortSignal.timeout(15_000) })
    await cleanup.stop({ signal: AbortSignal.timeout(15_000) })
  }
}, 120_000)
