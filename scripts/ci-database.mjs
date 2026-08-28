import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { assertDatabaseTypesMatch } from './check-database-types.mjs'
import { isolatedBuildEnvironment, withProductionServer, checkAnonymousRoutes } from './ci-smoke.mjs'

// This runner must never use a linked/hosted database or a developer's .env.
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.CI !== 'true') throw new Error('Database replay runner is restricted to disposable GitHub CI.')
if (readdirSync('.').some(name => name.startsWith('.env') && name !== '.env.example')) throw new Error('Private environment files must not be present in CI.')
const cli = ['--yes', 'supabase@2.116.0']
const options = { encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }
function capture(command, args, extra = {}) {
  try { return execFileSync(command, args, { ...options, ...extra }) }
  catch { throw new Error('Isolated database command failed; raw command output is withheld to protect fixture credentials.') }
}
const status = JSON.parse(capture('npx', [...cli, 'status', '--output', 'json']))
const url = new URL(status.API_URL)
if (url.origin !== 'http://127.0.0.1:54321' || url.href !== `${url.origin}/`) throw new Error('CI database must be the fixed local Supabase service.')
const publicKey = status.PUBLISHABLE_KEY ?? status.ANON_KEY
const serverKey = status.SECRET_KEY ?? status.SERVICE_ROLE_KEY
if (typeof publicKey !== 'string' || typeof serverKey !== 'string') throw new Error('Missing disposable database keys.')
// Do not echo status output: it contains disposable credentials. These keys
// are never written to a file, artifact, job output or GITHUB_ENV.
const env = { ...isolatedBuildEnvironment(), NEXT_PUBLIC_SUPABASE_URL: url.origin,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publicKey, SUPABASE_SECRET_KEY: serverKey,
  CRON_SECRET: randomBytes(32).toString('hex') }

for (const name of readdirSync('supabase/tests').filter(name => name.endsWith('.sql')).sort()) {
  console.log(`Database invariant: ${name}`)
  capture('docker', ['exec', '-i', 'supabase_db_vibe-coding-platform', 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    { input: readFileSync(`supabase/tests/${name}`, 'utf8') })
}
const generated = capture('npx', [...cli, 'gen', 'types', '--local', '--lang', 'typescript', '--schema', 'public'])
assertDatabaseTypesMatch(readFileSync('lib/supabase/database.types.ts', 'utf8'), generated)
console.log('Public database types match the replayed schema.')

function run(script, args = [], extra = {}) {
  const result = spawnSync(process.execPath, [script, ...args], { env: { ...env, ...extra }, stdio: 'inherit', timeout: 600_000 })
  if (result.error || result.status !== 0) throw new Error('Isolated database application check failed.')
}
run('node_modules/next/dist/bin/next', ['build'])
await withProductionServer(env, async base => {
  await checkAnonymousRoutes(base)
  run('scripts/verify-worker-health.mjs', [], { TEST_APP_URL: base })
  run('scripts/verify-auth-projects.mjs', [], { TEST_APP_URL: base })
  run('scripts/verify-sandbox-cleanup.mjs', [], { RUN_SANDBOX_CLEANUP_CHECK: '1' })
  run('scripts/ci-browser.mjs', [], { TEST_APP_URL: base })
})
console.log('PASS: clean migrations, SQL invariants, generated types, authenticated HTTP and browser checks on an isolated database.')
