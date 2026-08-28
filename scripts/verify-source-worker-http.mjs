// Local production-server smoke check; no VM, AI call, or email is created.
// Refuse to drain a nonempty queue: active-capture tests have their own fixtures.
import assert from 'node:assert/strict'
import { createClient } from '@supabase/supabase-js'

const base = new URL(process.env.BASE_URL ?? 'http://localhost:3010')
if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) || base.protocol !== 'http:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
  throw new Error('Run this smoke check against a local application origin only.')
}
const secret = process.env.CRON_SECRET
if (!secret || secret.length < 32) throw new Error('Load the local worker secret first.')
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})
const queue = await admin.from('source_capture_jobs').select('id', { head: true, count: 'exact' })
  .in('state', ['queued', 'capturing', 'acknowledging']).abortSignal(AbortSignal.timeout(10_000))
if (queue.error || queue.count !== 0) throw new Error('The capture queue must be verified empty before this smoke check.')
for (const [name, authorization, expected] of [
  ['missing', undefined, 401],
  ['incorrect', `Bearer ${'x'.repeat(64)}`, 401],
  ['authorized', `Bearer ${secret}`, 200],
]) {
  const response = await fetch(new URL('/api/internal/source-capture', base), {
    headers: authorization ? { authorization } : {}, redirect: 'error', signal: AbortSignal.timeout(60_000),
  })
  assert.equal(response.status, expected, `${name}: unexpected worker response status`)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert(response.headers.get('x-request-id'))
  const body = await response.json()
  if (name === 'authorized') assert.deepEqual(body, { processed: 0, failed: 0 })
  else assert.equal(body.error?.code, 'WORKER_AUTH_REQUIRED')
  console.log(JSON.stringify({ check: name, status: response.status, passed: true }))
}
