// Only the fresh disposable CI database. Never run worker fixtures on hosted
// customer data, and never print keys, auth headers, provider output or bodies.
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

if (process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true') throw new Error('Worker verification is restricted to disposable GitHub CI.')
if (readdirSync('.').some(name => name.startsWith('.env') && name !== '.env.example')) throw new Error('Private environment files must not be present in CI.')
const base = process.env.TEST_APP_URL, database = process.env.NEXT_PUBLIC_SUPABASE_URL
if (base !== 'http://127.0.0.1:3115' || database !== 'http://127.0.0.1:54321') throw new Error('Worker verification requires fixed disposable local services.')
if (['VERCEL_AUTH_TOKEN', 'VERCEL_OIDC_TOKEN', 'VERCEL_TOKEN', 'AI_GATEWAY_API_KEY', 'SUPABASE_ACCESS_TOKEN'].some(name => process.env[name])) throw new Error('Hosted service credentials must not be present.')
const secret = process.env.CRON_SECRET
if (!secret || secret.length < 32) throw new Error('Missing disposable worker authorization.')
const boundedFetch = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) })
const options = { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: boundedFetch } }
const admin = createClient(database, process.env.SUPABASE_SECRET_KEY, options)
const anonymous = createClient(database, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, options)
async function rpc(name, args) {
  const response = await admin.rpc(name, args)
  if (response.error) throw new Error(`Worker database check failed: ${name}`)
  return response.data
}
async function get(path, authorized = true) {
  const response = await fetch(`${base}/api/internal/${path}`, {
    headers: authorized ? { authorization: `Bearer ${secret}` } : {},
    redirect: 'manual', signal: AbortSignal.timeout(10_000),
  })
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert(response.headers.get('x-request-id'))
  return { status: response.status, data: await response.json() }
}

let phase = 'empty-database guard'
try {
  for (const table of ['projects', 'sandbox_sessions', 'source_capture_jobs', 'sandbox_cleanup_jobs']) {
    const response = await admin.from(table).select('id', { count: 'exact', head: true })
    if (response.error || response.count !== 0) throw new Error('Worker checks require a freshly replayed, empty database.')
  }
  phase = 'authorization'
  const workers = ['source-capture', 'sandbox-cleanup', 'archive-cleanup']
  for (const route of [...workers, 'worker-health']) {
    const denied = await get(route, false)
    assert.equal(denied.status, 401); assert.equal(denied.data.error.code, 'WORKER_AUTH_REQUIRED')
  }
  for (const [name, args] of [
    ['read_worker_invocation_health', {}],
    ['begin_worker_invocation', { p_worker_name: workers[0], p_run_id: randomUUID() }],
    ['finish_worker_invocation', { p_worker_name: workers[0], p_run_id: randomUUID(), p_succeeded: true }],
  ]) assert((await anonymous.rpc(name, args)).error, 'Anonymous Data API must not expose worker functions')
  phase = 'never-run health'
  const absent = await get('worker-health')
  assert.equal(absent.status, 503)
  assert.deepEqual(absent.data.workers.map(worker => worker.status), Array(3).fill('never-run'))
  phase = 'empty source-capture batch'
  const source = await get('source-capture')
  assert.equal(source.status, 200); assert.deepEqual(source.data, { processed: 0, failed: 0 })
  phase = 'empty sandbox-cleanup batch'
  const cleanup = await get('sandbox-cleanup')
  assert.equal(cleanup.status, 200); assert.deepEqual(cleanup.data, { processed: 0, failed: 0, unconfirmed: 0 })
  phase = 'empty archive-cleanup batch'
  const archive = await get('archive-cleanup')
  assert.equal(archive.status, 200); assert.deepEqual(archive.data, { removed: 0, importsRemoved: 0, archiveImportsRemoved: 0 })
  phase = 'healthy read-only snapshot'
  const current = await get('worker-health')
  assert.equal(current.status, 200); assert.equal(current.data.status, 'healthy')
  assert.deepEqual(current.data.workers.map(worker => worker.name), workers)
  assert.deepEqual(current.data.workers.map(worker => worker.status), Array(3).fill('healthy'))
  const second = await get('worker-health')
  assert.deepEqual(second.data.workers, current.data.workers, 'Polling must not refresh worker invocation timestamps')

  // Concurrent arrivals share one bounded row; exactly the winning invocation
  // can settle it. Older completions cannot overwrite the new outcome.
  phase = 'concurrent completion fencing'
  const ids = [randomUUID(), randomUUID()]
  await Promise.all(ids.map(p_run_id => rpc('begin_worker_invocation', { p_worker_name: 'archive-cleanup', p_run_id })))
  const settlements = await Promise.all(ids.map(p_run_id => rpc('finish_worker_invocation', { p_worker_name: 'archive-cleanup', p_run_id, p_succeeded: false })))
  assert.equal(settlements.filter(Boolean).length, 1)
  const failed = await get('worker-health')
  assert.equal(failed.status, 503)
  assert.equal(failed.data.workers.find(worker => worker.name === 'archive-cleanup').status, 'failed')
  phase = 'recovery'
  assert.equal((await get('archive-cleanup')).status, 200)
  assert.equal((await get('worker-health')).status, 200)
  console.log('PASS: protected worker routes, never-run/healthy/failed HTTP states, read-only polling, real empty batches, and concurrent completion fencing. No paid service used.')
} catch {
  console.error(`Isolated worker-health verification failed at ${phase}; fixture credentials and response bodies are withheld.`)
  process.exitCode = 1
}
