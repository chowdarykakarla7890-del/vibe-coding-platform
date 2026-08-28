// Explicit local-only browser QA fixture, never an application auth endpoint.
// Creates one disposable account and authenticates it through Supabase's real
// password grant. Browser navigation receives normal SSR cookies. No existing
// browser sessions are read, and no account credentials appear in HTML, URLs or logs.
import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { createServerClient, serializeCookieHeader } from '@supabase/ssr'
import { Sandbox } from '@vercel/sandbox'
import { getSandboxCredentials, isSandboxUnavailableError } from '../ai/sandbox.ts'

if (process.env.RUN_BROWSER_WORKSPACE_FIXTURE !== '1' || process.env.VERCEL) throw new Error('Opt in locally with RUN_BROWSER_WORKSPACE_FIXTURE=1.')
const app = new URL(process.env.TEST_APP_URL ?? 'http://127.0.0.1:3112')
if (app.protocol !== 'http:' || app.hostname !== '127.0.0.1' || Number(app.port) < 1024 || !app.port || app.username || app.password || app.pathname !== '/' || app.search || app.hash) throw new Error('Use only an http://127.0.0.1:<unprivileged-port> local application origin.')
const fixturePort = Number(process.env.TEST_BROWSER_PORT ?? '3113')
if (!Number.isInteger(fixturePort) || fixturePort < 1024 || fixturePort > 65535 || fixturePort === Number(app.port)) throw new Error('Choose a separate unprivileged loopback fixture port.')
const origin = `http://127.0.0.1:${fixturePort}`
const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, secret = process.env.SUPABASE_SECRET_KEY
if (!url || !key || !secret) throw new Error('Load the configured local Supabase environment.')
const boundedFetch = (input, init) => fetch(input, { ...init, signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(init?.signal ? [init.signal] : [])]) })
const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: boundedFetch } })
const cookies = new Map()
const client = createServerClient(url, key, { global: { fetch: boundedFetch }, cookies: {
  getAll: () => [...cookies.values()],
  setAll: values => values.forEach(value => cookies.set(value.name, value)),
} })
const email = `browser-workspace-${randomUUID()}@example.invalid`, password = randomBytes(24).toString('hex')
const nonce = randomBytes(24).toString('hex')
let userId, started = false, busy = false, cleanupPromise
let finishRun
const finished = new Promise(resolve => { finishRun = resolve })

async function stopSandboxes() {
  if (!userId) return
  const rows = await admin.from('sandbox_sessions').select('id,sandbox_id').eq('user_id', userId)
  if (rows.error) throw new Error('Disposable sandbox lookup failed.')
  const failures = []
  for (const row of rows.data) {
    const name = row.sandbox_id ?? `codetutor-${row.id}`
    try {
      const box = await Sandbox.get({ name, resume: false, ...getSandboxCredentials(), signal: AbortSignal.timeout(10_000) })
      await box.stop({ signal: AbortSignal.timeout(15_000) })
    } catch (error) { if (!isSandboxUnavailableError(error)) failures.push(name) }
  }
  if (failures.length) throw new Error(`Disposable sandbox cleanup unconfirmed: ${failures.join(', ')}`)
}

function cleanup() {
  return cleanupPromise ??= (async () => {
    const errors = []
    try { await stopSandboxes() } catch (error) { errors.push(error.message) }
    try { if ((await client.auth.signOut({ scope: 'global' })).error) errors.push('Disposable sign-out failed.') } catch { errors.push('Disposable sign-out failed.') }
    if (userId) {
      try { if ((await admin.auth.admin.deleteUser(userId)).error) errors.push('Disposable account removal failed.') } catch { errors.push('Disposable account removal failed.') }
    }
    if (errors.length) throw new Error(errors.join(' '))
    console.log('Cleaned up disposable browser account, sessions, projects and sandboxes.')
  })()
}

function form(path, label) { return `<form method="post" action="${path}"><input type="hidden" name="nonce" value="${nonce}"><button>${label}</button></form>` }
const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'private, no-store')
  response.setHeader('Content-Type', 'text/html; charset=utf-8')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'same-origin')
  response.setHeader('Content-Security-Policy', `default-src 'none'; form-action 'self' ${app.origin}; frame-ancestors 'none'; base-uri 'none'`)
  if (request.headers.host !== `127.0.0.1:${fixturePort}`) { response.writeHead(403).end('Local fixture only.'); return }
  if (request.method === 'GET' && request.url === '/') {
    response.end(`<!doctype html><html lang="en"><title>CodeTutor browser QA</title><h1>Disposable browser QA</h1><p>This is not customer sign-in. Use a signed-out local preview only. Email delivery and OAuth are not tested here.</p>${started ? `<a href="${app.origin}/playground">Return to workspace</a>${form('/expire', 'Expire test sandboxes')}` : form('/start', 'Start disposable workspace session')}${form('/finish', 'Finish and remove test resources')}</html>`)
    return
  }
  if (request.method !== 'POST' || !['/start','/expire','/finish'].includes(request.url) || request.headers.origin !== origin || request.headers['content-type'] !== 'application/x-www-form-urlencoded') {
    console.warn('Fixture form rejected', { method: request.method, origin: request.headers.origin, contentType: request.headers['content-type'] })
    response.writeHead(403).end('Fixture request rejected.'); return
  }
  try {
    let body = ''
    for await (const chunk of request) { body += chunk; if (body.length > 1024) throw new Error('Fixture request too large.') }
    if (new URLSearchParams(body).get('nonce') !== nonce || busy) { response.writeHead(409).end('Fixture request unavailable.'); return }
    busy = true
    if (request.url === '/start') {
      if (started) { response.writeHead(409).end('Fixture session already started.'); return }
      const result = await client.auth.signInWithPassword({ email, password })
      if (result.error) throw new Error('Disposable sign-in failed.')
      started = true
      response.setHeader('Set-Cookie', [...cookies.values()].map(({name,value,options}) => serializeCookieHeader(name,value,options)))
      response.writeHead(303, { Location: `${app.origin}/playground` }).end()
    } else if (request.url === '/expire') {
      await stopSandboxes()
      response.end('<!doctype html><html lang="en"><title>Test sandboxes stopped</title><h1>Test sandboxes stopped</h1><p>Saved source was not changed. Return to the workspace to check expiration and recovery.</p></html>')
    } else {
      await cleanup()
      response.setHeader('Set-Cookie', [...cookies.values()].map(({name,value,options}) => serializeCookieHeader(name,value,options)))
      response.end('<!doctype html><html lang="en"><title>QA complete</title><h1>Test resources removed</h1></html>')
      finishRun()
    }
  } catch (error) {
    console.error('Browser fixture operation failed', { errorName: error.name })
    response.writeHead(502).end('Fixture operation failed. No raw provider data is shown; stop the fixture to run cleanup.')
  } finally { busy = false }
})
server.requestTimeout = 10_000
server.headersTimeout = 5000
const timer = setTimeout(() => finishRun(), 25 * 60_000)
process.once('SIGINT', finishRun)
process.once('SIGTERM', finishRun)
try {
  // Bind before account creation, so an occupied port creates no orphan user.
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(fixturePort,'127.0.0.1',resolve) })
  const created = await admin.auth.admin.createUser({ email,password,email_confirm:true })
  if (created.error || !created.data.user) throw new Error('Disposable account creation failed.')
  userId = created.data.user.id
  console.log(`Disposable browser fixture ready at ${origin}; automatic cleanup after 25 minutes.`, { userId })
  await finished
} finally {
  clearTimeout(timer)
  server.close()
  await cleanup()
}
