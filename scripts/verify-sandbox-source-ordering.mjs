// Opt-in live test of the actual source writer, using one disposable VM only.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Sandbox } from '@vercel/sandbox'
import { applySandboxSource, SOURCE_APPLY_PROGRAM } from '../lib/sandbox/source-apply.ts'
import { guardedCommand } from '../lib/server/command-guard.ts'

const credentials = { token: process.env.VERCEL_AUTH_TOKEN, teamId: process.env.VERCEL_TEAM_ID, projectId: process.env.VERCEL_PROJECT_ID }
if (Object.values(credentials).some((value) => !value)) throw new Error('Load the configured sandbox credentials first.')
const sandbox = await Sandbox.create({ ...credentials, name: `codetutor-source-check-${randomUUID()}`, persistent: false, timeout: 240_000, signal: AbortSignal.timeout(45_000) })
const file = (revision, content = `revision ${revision}`) => ({ path: 'src/main.ts', content, revision })
try {
  const vm = sandbox.currentSession()
  const layout = await vm.runCommand({ cmd: '/usr/bin/python3', args: ['-I', '-S', '-c', "import os,json; print(json.dumps({'varLib':os.path.isdir('/var/lib'),'workspace':os.path.isdir('/vercel/sandbox'),'root':os.path.isdir('/root')}))"], cwd: '/', sudo: true, timeoutMs: 3_000, signal: AbortSignal.timeout(5_000) })
  console.log('Sandbox source layout', { cwd: vm.cwd, paths: JSON.parse(await layout.stdout()) })
  const read = async (path = 'src/main.ts') => (await vm.readFileToBuffer({ path }, { signal: AbortSignal.timeout(10_000) }))?.toString('utf8')
  let resume, uploaded
  const gate = new Promise((resolve) => { resume = resolve })
  const staged = new Promise((resolve) => { uploaded = resolve })
  const older = applySandboxSource({
    cwd: vm.cwd,
    writeFiles: async (...args) => { await vm.writeFiles(...args); uploaded(); await gate },
    runCommand: vm.runCommand.bind(vm),
  }, [file(1)])
  // Observe rejection immediately, even if a later diagnostic step fails.
  const olderResult = older.then(() => undefined, (error) => error)
  try {
    await Promise.race([staged, older])
    try { await applySandboxSource(vm, [file(2)]) }
    catch (error) {
      // Synthetic fixture only: report an OS error code/function, not source or
      // provider bodies. The production helper intentionally redacts these.
      const probe = `scope = {'__name__': 'test'}\nexec(${JSON.stringify(SOURCE_APPLY_PROGRAM)}, scope)\nimport json, traceback\ntry: scope['apply']([{'path':'src/main.ts','content':'revision 2','revision':2}], ${JSON.stringify(vm.cwd)})\nexcept BaseException as error: print(json.dumps({'type':type(error).__name__, 'errno':getattr(error,'errno',None), 'code':getattr(error,'code',None), 'functions':[(frame.name,frame.lineno) for frame in traceback.extract_tb(error.__traceback__)]}))`
      const diagnostic = await vm.runCommand({ cmd: '/usr/bin/python3', args: ['-I', '-S', '-c', probe], cwd: '/', sudo: true, timeoutMs: 5_000, signal: AbortSignal.timeout(10_000) })
      console.log('Synthetic source diagnostic', await diagnostic.stdout())
      throw error
    }
  } finally { resume() }
  assert.equal((await olderResult)?.code, 'SOURCE_SUPERSEDED')
  assert.equal(await read(), 'revision 2')
  console.log('PASS: delayed revision 1 cannot overwrite already-applied revision 2.')

  const results = await Promise.allSettled(Array.from({ length: 6 }, (_, index) => applySandboxSource(vm, [file(index + 3)])))
  assert(results.every((result) => result.status === 'fulfilled' || result.reason.code === 'SOURCE_SUPERSEDED'))
  assert.equal(await read(), 'revision 8')
  console.log('PASS: concurrent writes settle on the highest revision.')

  const interruption = `scope = {'__name__': 'test'}\nexec(${JSON.stringify(SOURCE_APPLY_PROGRAM)}, scope)\nimport os\noriginal = scope['atomic_write']\ndef interrupted(parent, name, *args):\n    if name == 'main.ts': os._exit(91)\n    return original(parent, name, *args)\nscope['atomic_write'] = interrupted\nscope['apply']([{'path':'src/main.ts','content':'repaired','revision':9}], ${JSON.stringify(vm.cwd)})`
  const killed = await vm.runCommand({ cmd: '/usr/bin/python3', args: ['-I', '-S', '-c', interruption], cwd: '/', sudo: true, timeoutMs: 5_000, signal: AbortSignal.timeout(10_000) })
  assert.equal(killed.exitCode, 91)
  assert.equal(await read(), 'revision 8')
  await assert.rejects(applySandboxSource(vm, [file(8)]), { code: 'SOURCE_SUPERSEDED' })
  await applySandboxSource(vm, [file(9, 'repaired')])
  assert.equal(await read(), 'repaired')
  console.log('PASS: process death after journaling fences old writes; the same revision repairs the file.')

  await assert.rejects(applySandboxSource({
    cwd: vm.cwd,
    writeFiles: (files, options) => vm.writeFiles(files.map((upload) => ({ ...upload, content: Buffer.from(JSON.stringify([file(999, 'tampered')])) })), options),
    runCommand: vm.runCommand.bind(vm),
  }, [file(10)]), { code: 'SOURCE_PAYLOAD_CHANGED' })
  assert.equal(await read(), 'repaired')
  const denied = await vm.runCommand({ ...guardedCommand('sh', ['-c', 'test -w src/main.ts && test ! -w /var/lib/codetutor-source-v1 && ! touch /var/lib/codetutor-source-v1/forged']), timeoutMs: 5_000, signal: AbortSignal.timeout(10_000) })
  assert.equal(denied.exitCode, 0)
  console.log('PASS: staged payload tampering is rejected; learner code can edit source but cannot alter the protected journal.')

  const unicode = '🙂'.repeat(65_536)
  await applySandboxSource(vm, [{ path: 'src/你好.txt', content: unicode, revision: 1 }])
  assert.equal(await read('src/你好.txt'), unicode)
  const sentinel = `codetutor-sentinel-${randomUUID()}.txt`
  await vm.writeFiles([{ path: `/tmp/${sentinel}`, content: Buffer.from('untouched') }])
  const linked = await vm.runCommand({ ...guardedCommand('ln', ['-s', '/tmp', 'unsafe']), timeoutMs: 5_000, signal: AbortSignal.timeout(10_000) })
  assert.equal(linked.exitCode, 0)
  await assert.rejects(applySandboxSource(vm, [{ path: `unsafe/${sentinel}`, content: 'blocked', revision: 1 }]))
  assert.equal(await read(`/tmp/${sentinel}`), 'untouched')
  console.log('PASS: 256 KB Unicode source is byte-exact and symlink targets remain untouched.')
} finally {
  await sandbox.stop({ signal: AbortSignal.timeout(15_000) })
  console.log('Stopped source-ordering diagnostic VM.')
}
