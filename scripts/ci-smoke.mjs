import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { setTimeout as pause } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

/** @param {Record<string, string | undefined>} env */
export function isolatedBuildEnvironment(env = process.env) {
  return { ...env, NODE_ENV: 'production', VERCEL: '0', VERCEL_ENV: '', VERCEL_TARGET_ENV: '',
    VERCEL_AUTH_TOKEN: '', VERCEL_OIDC_TOKEN: '', VERCEL_TOKEN: '', VERCEL_PROJECT_ID: '', VERCEL_TEAM_ID: '',
    AI_GATEWAY_API_KEY: '', OPENAI_API_KEY: '', SUPABASE_ACCESS_TOKEN: '', SUPABASE_SECRET_KEY: '', CRON_SECRET: '',
    NEXT_TELEMETRY_DISABLED: '1', NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_ci_placeholder_not_a_real_key' }
}

/** Owns only this child, never kills a process found by port or name. */
export async function withProductionServer(env, callback) {
  const base = 'http://127.0.0.1:3115'
  const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3115'],
    { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let ready = false, ended = false
  const closed = new Promise(resolve => {
    server.once('error', () => { ended = true; resolve() })
    server.once('exit', () => { ended = true; resolve() })
  })
  // Do not echo runtime logs containing fixture tokens or raw provider errors.
  let startup = ''
  server.stdout.on('data', chunk => { startup = (startup + chunk.toString()).slice(-4096); if (/Ready in/.test(startup)) ready = true })
  server.stderr.resume()
  try {
    const deadline = Date.now() + 20_000
    while (!ready && !ended && Date.now() < deadline) await pause(100)
    if (!ready || ended) throw new Error('The isolated production server did not start. Check the build and port 3115.')
    return await callback(base)
  } finally {
    if (!ended) server.kill('SIGTERM')
    await Promise.race([closed, pause(5000)])
    if (!ended) { server.kill('SIGKILL'); await closed }
  }
}

export async function checkAnonymousRoutes(base, fetcher = fetch) {
  const get = path => fetcher(new URL(path, base), { redirect: 'manual', signal: AbortSignal.timeout(5000) })
  const login = await get('/sign-in')
  assert.equal(login.status, 200)
  assert((await login.text()).includes('CodeTutor'))
  const workspace = await get('/playground')
  assert.equal(workspace.status, 307)
  assert.equal(new URL(workspace.headers.get('location'), base).pathname, '/sign-in')
  assert.equal(workspace.headers.get('cache-control'), 'private, no-store')
  const models = await (await get('/api/models')).json()
  assert.equal(models.models.length, 8)
  assert.deepEqual(models.models.map(model => model.tier), [...Array(4).fill('primary'), ...Array(4).fill('affordable')])
  const projects = await get('/api/projects')
  assert.equal(projects.status, 401)
  assert.equal((await projects.json()).error.code, 'AUTH_REQUIRED')
  assert(projects.headers.get('x-request-id'))
  assert.equal(projects.headers.get('cache-control'), 'private, no-store')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await withProductionServer(isolatedBuildEnvironment(), checkAnonymousRoutes)
    console.log('PASS: production boot, sign-in redirect, eight model tiers and protected API. No paid service used.')
  } catch {
    console.error('Production HTTP smoke check failed. Run the isolated build and inspect route assertions.')
    process.exitCode = 1
  }
}
