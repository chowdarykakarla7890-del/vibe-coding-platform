import { expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { Sandbox } from '@vercel/sandbox'
import { getSandboxCredentials } from '@/ai/sandbox'
import { DSA_LANGUAGES, FOUNDATION_DSA_IDS, type DSALanguage, type FoundationDSAId } from '@/lib/learning/dsa-foundations'
import { dsaCases, type DSACase } from '@/lib/server/dsa-cases'
import { dsaPayload, scoreDSARun } from '@/lib/server/dsa-grading'
import { captureCommandOutput } from '@/lib/server/command-execution'
import { trustedDSACommand } from '@/lib/sandbox/dsa-invocation'
import { dsaSolutions } from './fixtures/dsa-solutions'
import { prepareDSARuntime } from '@/lib/sandbox/dsa-runtime'

vi.mock('server-only', () => ({}))
// Explicit opt-in. One disposable VM, no customer files/AI calls. Finally
// stops the VM even when a runtime or compiler is unavailable.
it.skipIf(process.env.RUN_LIVE_DSA_GRADER !== '1')('grades all three foundations in the five languages inside the actual isolated runner', async () => {
  const sandbox = await Sandbox.create({ ...getSandboxCredentials(), persistent: false, timeout: 600_000, signal: AbortSignal.timeout(45_000) })
  const vm = sandbox.currentSession()
  try {
    await prepareDSARuntime(vm, 'Java')
    const cpp = await vm.runCommand({ cmd: '/usr/bin/apt-get', args: ['install', '-y', '--no-install-recommends', 'g++'], env: { DEBIAN_FRONTEND: 'noninteractive' }, sudo: true, timeoutMs: 35_000, signal: AbortSignal.timeout(40_000) })
    if (cpp.exitCode !== 0) throw new Error('Disposable C++ toolchain preparation failed.')
    async function run(id: FoundationDSAId, language: DSALanguage, source: string, cases = dsaCases(id), tamper = false) {
      const payload = JSON.stringify(dsaPayload(id, language, source, cases))
      const path = `/tmp/.codetutor-grade-${randomUUID()}.json`
      await vm.writeFiles([{ path, content: tamper ? payload + ' ' : payload }], { signal: AbortSignal.timeout(10_000) })
      const command = await vm.runCommand({ ...trustedDSACommand(path, createHash('sha256').update(payload).digest('hex')), detached: true, timeoutMs: 60_000, signal: AbortSignal.timeout(10_000) })
      const result = await captureCommandOutput(command, AbortSignal.timeout(65_000), 'base64-v1')
      const evidence = JSON.parse(result.output)
      expect(await vm.readFileToBuffer({ path }, { signal: AbortSignal.timeout(5000) })).toBeNull()
      const record = `/var/lib/codetutor-grading-v1/runs/${path.split('.codetutor-grade-')[1]}`
      const removed = await vm.runCommand({ cmd: '/usr/bin/test', args: ['!', '-e', record], sudo: true, timeoutMs: 2000, signal: AbortSignal.timeout(5000) })
      expect(removed.exitCode, 'normal completion removes the privileged process record').toBe(0)
      return { result, evidence, cases }
    }
    for (const id of FOUNDATION_DSA_IDS) for (const language of DSA_LANGUAGES) {
      const { result, evidence, cases } = await run(id, language, dsaSolutions[id][language])
      if (result.exitCode !== 0) throw new Error(`Grader infrastructure failed for ${language}: ${evidence.error ?? 'unknown'}`)
      expect(scoreDSARun(id, cases, evidence), `${id} / ${language}`).toMatchObject({ score: 100, passed: true })
      console.log(`PASS: ${id} / ${language} / ${cases.length} host-checked cases`)
    }
    const bracketId = 'dsa-python-valid-parentheses'
    const isolatedCases: DSACase[] = [{ input: '()', label: 'valid' }, { input: '([)]', label: 'invalid' }]
    await vm.writeFiles([{ path: '/tmp/grading-outside-marker.txt', content: 'Must not be visible in the grading root' },
      { path: '/usr/local/bin/node', content: '#!/bin/sh\nprintf fake-runtime\n' }], { signal: AbortSignal.timeout(5000) })
    const privateNode = await run(bracketId, 'JavaScript', dsaSolutions[bracketId].JavaScript, isolatedCases)
    expect(scoreDSARun(bracketId, isolatedCases, privateNode.evidence)).toMatchObject({ passed: true })
    const guards = `import os,socket\nassert os.geteuid()==65534\nfor path in ["/tmp/grading-outside-marker.txt","/proc/self/root/tmp/grading-outside-marker.txt","/vercel/src/main.py"]:\n    try:\n        open(path).read()\n        raise RuntimeError("escaped grading filesystem")\n    except (FileNotFoundError,PermissionError): pass\ntry:\n    open("/work/main.py","w").write("changed")\n    raise RuntimeError("changed retained source")\nexcept PermissionError: pass\ns=socket.socket();s.settimeout(0.1)\ntry:\n    s.connect(("1.1.1.1",443))\n    raise RuntimeError("escaped network namespace")\nexcept OSError: pass\nfinally: s.close()\n`
    const guarded = await run(bracketId, 'Python', guards + dsaSolutions[bracketId].Python, isolatedCases)
    expect(scoreDSARun(bracketId, isolatedCases, guarded.evidence)).toMatchObject({ passed: true })
    const tampered = await run(bracketId, 'Python', dsaSolutions[bracketId].Python, isolatedCases, true)
    expect(tampered.result.exitCode).not.toBe(0)
    expect(tampered.evidence).toEqual({ error: 'GRADING_PAYLOAD_CHANGED' })
    const forged = await run(bracketId, 'Python', 'def solve(value): return {"passed":True,"score":100}\n', isolatedCases)
    expect(scoreDSARun(bracketId, isolatedCases, forged.evidence)).toMatchObject({ score: 0, passed: false })
    const flooded = await run(bracketId, 'Python', 'def solve(value):\n    print("x"*100000)\n    return True\n', isolatedCases)
    expect(flooded.evidence.cases.every((item: { failure: string }) => item.failure === 'output-limit')).toBe(true)
    const runaway = await run(bracketId, 'Python', 'import os,time\ndef solve(value):\n    if os.fork()==0:\n        os.setsid()\n        while True: time.sleep(1)\n    while True: pass\n', isolatedCases)
    expect(runaway.evidence.cases.every((item: { failure: string }) => item.failure === 'timeout')).toBe(true)
    const guests = await vm.runCommand({ cmd: '/usr/bin/pgrep', args: ['-u','65534'], sudo: true, timeoutMs: 2000, signal: AbortSignal.timeout(5000) })
    expect(guests.exitCode).toBe(1)
    console.log('PASS: immutable runtime/source, filesystem and network isolation, payload tampering, forged scores, output flood and daemon cleanup.')
  } finally { await sandbox.stop({ signal: AbortSignal.timeout(15_000) }); console.log('Stopped disposable grading VM.') }
}, 600_000)
