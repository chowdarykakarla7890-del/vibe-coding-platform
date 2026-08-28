// Bounded, local-only source-journal stress check. Executes the exact embedded
// program with private fixture roots/owner; no VM, credentials or learner code.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { randomUUID } from 'node:crypto'
import ts from 'typescript'
import * as runtime from '../lib/sandbox/runtime-programs.mjs'

const require = createRequire(import.meta.url), exported = {}
const compiled = ts.transpileModule(readFileSync(new URL('../lib/sandbox/source-apply.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
runInNewContext(compiled, { exports: exported, require: name => {
  if (name === './runtime-programs.mjs') return runtime
  if (name === 'node:crypto') return require(name)
  throw new Error('Unexpected source-program dependency')
} })
const program = exported.SOURCE_APPLY_PROGRAM
assert.equal(typeof program, 'string')
const execute = promisify(execFile)
const rounds = Number(process.env.SOURCE_CONCURRENCY_ROUNDS ?? 8)
assert(Number.isInteger(rounds) && rounds >= 1 && rounds <= 40, 'Use 1–40 stress rounds')
const runner = `
scope={'__name__':'test'}
exec(${JSON.stringify(program)},scope)
import json,os,sys
try:
    with open(sys.argv[1]) as stream: files=json.load(stream)
    print(json.dumps({'applied':scope['apply'](files,sys.argv[2],sys.argv[3],os.getuid())}))
except scope['ApplyFailure'] as error: print(json.dumps({'error':error.code}))
except OSError as error:
    import traceback
    print(json.dumps({'error':'OS_ERROR','errno':error.errno,'trace':[{'operation':f.name,'line':f.lineno} for f in traceback.extract_tb(error.__traceback__)]}))
`
for (let round = 1; round <= rounds; round++) {
  const directory = await mkdtemp(join(tmpdir(), 'codetutor-source-concurrency-'))
  const workspace = join(directory, 'workspace'), state = join(directory, 'state')
  try {
    await mkdir(workspace)
    const jobs = Array.from({ length: 10 }, async (_, index) => {
      const input = join(directory, `${randomUUID()}.json`)
      await writeFile(input, JSON.stringify([{ path: 'src/main.ts', content: `revision ${index + 1}`, revision: index + 1 }]))
      const response = await execute(process.env.CODETUTOR_TEST_PYTHON ?? 'python3', ['-I', '-S', '-c', runner, input, workspace, state], { timeout: 10_000, maxBuffer: 64 * 1024 })
      return JSON.parse(response.stdout)
    })
    // Always settle child processes before deleting their fixture directory.
    const settled = await Promise.allSettled(jobs)
    if (settled.some(result => result.status === 'rejected')) throw new Error('Source fixture process failed or exceeded its deadline.')
    const results = settled.map(result => result.value)
    const failures = results.filter(result => !result.applied && result.error !== 'SOURCE_SUPERSEDED')
    if (failures.length) {
      console.error(JSON.stringify({ round, failures }))
      throw new Error('Concurrent source application failed.')
    }
    assert.equal(await readFile(join(workspace, 'src/main.ts'), 'utf8'), 'revision 10')
    console.log(`Source concurrency round ${round}/${rounds}: passed`)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
