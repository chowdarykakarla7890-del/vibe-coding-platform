// Opt-in live integration: two disposable users, one disposable project and
// two sequential paid ephemeral VMs. Never run against a production app URL.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'

const base = process.env.TEST_APP_URL ?? 'http://localhost:3010'
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('Use the local application for this live check.')
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const publicKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
const secret = process.env.SUPABASE_SECRET_KEY
if (!url || !publicKey || !secret) throw new Error('Load the Supabase configuration first.')
const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } })
const users = []
const clients = []
let sandboxId
let owner
let projectId

async function account() {
  const email = `codetutor-smoke-${randomUUID()}@example.invalid`
  const password = randomBytes(24).toString('hex')
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (error) throw new Error(`Temporary account creation failed (${error.status ?? 'unknown'}).`)
  users.push(data.user.id)
  const cookies = new Map()
  const client = createServerClient(url, publicKey, { cookies: {
    getAll: () => [...cookies].map(([name, value]) => ({ name, value })),
    setAll: (entries) => entries.forEach(({ name, value }) => cookies.set(name, value)),
  } })
  clients.push(client)
  if ((await client.auth.signInWithPassword({ email, password })).error) throw new Error('Temporary sign-in failed.')
  return { id: data.user.id, cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') }
}
async function request(path, user = owner, method = 'GET', body, signal) {
  return fetch(new URL(path, base), { method, redirect: 'manual', signal: signal ?? AbortSignal.timeout(65_000), headers: {
    ...(user ? { cookie: user.cookie, 'X-CodeTutor-Account': user.id } : {}),
    ...(method !== 'GET' ? { origin: base, 'content-type': 'application/json' } : {}),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
async function successful(response, expected = 200) {
  const body = await response.json()
  if (response.status !== expected) throw new Error(`Live request failed: HTTP ${response.status}, code ${body.error?.code ?? 'unknown'}.`)
  return body
}
async function command(text) {
  return (await successful(await request(`/api/sandboxes/${sandboxId}/terminal`, owner, 'POST', { command: text }))).cmdId
}
async function output(cmdId, cursor = 'v3.0.0') {
  let text = ''
  let stdout = ''
  let stderr = ''
  let windows = 0
  while (windows++ < 15) {
    const started = Date.now()
    const response = await request(`/api/sandboxes/${sandboxId}/cmds/${cmdId}/logs?cursor=${cursor}`)
    if (!response.ok) await successful(response)
    const body = await response.text()
    assert(Buffer.byteLength(body) <= 64 * 1024, 'Log windows must remain bounded')
    let status
    for (const line of body.trim().split('\n')) {
      const record = JSON.parse(line)
      if (record.type === 'error') throw new Error(`Log stream error: ${record.error.code}`)
      if (record.type === 'log') {
        const offsets = cursor.split('.').slice(1).map(Number)
        offsets[record.stream === 'stdout' ? 0 : 1] += Buffer.byteLength(record.data)
        assert.equal(record.cursor, `v3.${offsets.join('.')}`, 'Cursor must acknowledge exactly the delivered UTF-8 bytes per stream')
        cursor = record.cursor
        text += record.data
        if (record.stream === 'stdout') stdout += record.data
        else stderr += record.data
      } else status = record
    }
    assert(status, 'Every window must end with an explicit status')
    console.log('Live log window', { window: windows, durationMs: Date.now() - started, bytes: Buffer.byteLength(body), cursor, status: status.status, exitCode: status.exitCode })
    if (status.status === 'done') return { text, stdout, stderr, windows, exitCode: status.exitCode }
    assert.equal(status.status, 'running')
  }
  throw new Error('Command did not settle within bounded log windows.')
}

try {
  owner = await account()
  const other = await account()
  const project = await successful(await request('/api/projects', owner, 'POST', { title: 'Temporary live Sandbox check' }), 201)
  projectId = project.project.id
  const created = await successful(await request('/api/sandboxes', owner, 'POST', { projectId, ports: [3000], timeout: 600_000 }), 201)
  sandboxId = created.sandboxId
  assert.equal(typeof sandboxId, 'string')
  console.log('Live owned sandbox created; checking writes and streaming.')

  const path = 'check.mjs'
  // Exercise the encoded transport's Unicode regression by default. Set 0
  // only when deliberately running the separate large-ASCII case.
  const line = process.env.TEST_LARGE_UNICODE === '0' ? 'line\n' : '🙂\n'
  const content = `process.stdout.write(${JSON.stringify(line)}.repeat(25000));process.stderr.write('end');`
  await successful(await request(`/api/sandboxes/${sandboxId}/files`, owner, 'PUT', { path, content }))
  const versionedPath = 'revision-check.ts'
  const firstWrite = await successful(await request(`/api/sandboxes/${sandboxId}/files`, owner, 'PUT', { path: versionedPath, content: 'first' }))
  assert.equal(firstWrite.revision, 1)
  const readVersion = await request(`/api/sandboxes/${sandboxId}/files?path=${versionedPath}`)
  assert.equal(readVersion.headers.get('x-source-revision'), '1')
  assert.equal(await readVersion.text(), 'first')
  const updated = await successful(await request(`/api/sandboxes/${sandboxId}/files`, owner, 'PUT', { path: versionedPath, content: 'newer', revision: 1 }))
  assert.equal(updated.revision, 2)
  const conflict = await request(`/api/sandboxes/${sandboxId}/files`, owner, 'PUT', { path: versionedPath, content: 'stale', revision: 1 })
  assert.equal(conflict.status, 409)
  assert.equal((await conflict.json()).error.code, 'SOURCE_CONFLICT')
  const unchanged = await successful(await request(`/api/sandboxes/${sandboxId}/snapshot`, owner, 'POST', { paths: [versionedPath] }))
  assert.equal(unchanged.files[0].content, 'newer', 'A rejected save must not change the live VM')
  console.log('PASS: versioned file read/edit and stale-write rejection preserve the live VM.')
  const saved = await successful(await request(`/api/projects/${projectId}/files`))
  assert(saved.files.some((file) => file.path === path && file.content === content), 'Source must be durable before the file API succeeds')
  const cmdId = await command('node check.mjs')
  assert.equal((await request(`/api/sandboxes/${sandboxId}/cmds/${cmdId}/logs`, other)).status, 404)
  assert.equal((await request(`/api/sandboxes/${sandboxId}/cmds/${cmdId}`, other)).status, 404)
  const actual = await output(cmdId)
  assert.equal(actual.exitCode, 0)
  assert(actual.stdout === line.repeat(25000), 'Large output must match exactly (use diagnose-sandbox-stream.mjs to isolate upstream Unicode corruption).')
  assert.equal(actual.stderr, 'end')
  assert(actual.windows > 1)
  console.log('PASS: live source persistence, two-user command isolation, large output and multi-window reconnection.')

  const unicode = await command('node -e "process.stdout.write(\'🙂你好 café\')"')
  assert.equal((await output(unicode)).stdout, '🙂你好 café')
  console.log('PASS: small Unicode command output.')

  assert.notEqual((await output(await command('id -u'))).stdout.trim(), '0', 'Commands must not run as root')
  const privileges = await output(await command('grep NoNewPrivs /proc/self/status; sudo -n id -u'))
  assert.match(privileges.stdout, /NoNewPrivs:\s+1/)
  assert.notEqual(privileges.exitCode, 0, 'Nested sudo must be blocked by the kernel, not just a model schema')
  console.log('PASS: unprivileged execution with inherited no-new-privileges protection.')

  const parallel = await Promise.all(Array.from({ length: 4 }, () => request(`/api/sandboxes/${sandboxId}/terminal`, owner, 'POST', { command: 'sleep 120', background: true })))
  assert.equal(parallel.filter((response) => response.status === 200).length, 3)
  assert.equal(parallel.filter((response) => response.status === 429).length, 1)
  const activeCommands = []
  for (const response of parallel) {
    if (response.status === 200) activeCommands.push((await response.json()).cmdId)
    else assert.equal((await response.json()).error.code, 'COMMAND_CONCURRENCY_LIMIT')
  }
  assert.equal((await request(`/api/sandboxes/${sandboxId}/cmds/${activeCommands[0]}`, other, 'DELETE')).status, 404)
  for (const id of activeCommands) await successful(await request(`/api/sandboxes/${sandboxId}/cmds/${id}`, owner, 'DELETE'))
  const audits = await admin.from('command_audits').select('status,command_id').eq('user_id', owner.id).in('command_id', activeCommands)
  assert.equal(audits.data?.length, 3)
  assert(audits.data.every((row) => row.status === 'cancelled'))
  console.log('PASS: live concurrent command quota, cross-user Stop denial, confirmed cleanup and audit outcomes.')

  const slow = await command('node -e "process.stdout.write(\'start\');setTimeout(()=>process.stdout.write(\'end\'),22500)"')
  const started = Date.now()
  const status = await successful(await request(`/api/sandboxes/${sandboxId}/cmds/${slow}`))
  assert.equal(status.status, 'running')
  assert(Date.now() - started < 10_000, 'Status must not wait for process completion')
  const delayed = await output(slow)
  assert.equal(delayed.text, 'startend')
  assert.equal(delayed.exitCode, 0)
  assert(delayed.windows >= 2, 'An idle reader must reconnect after its 20-second window')
  console.log('PASS: live nonblocking status and idle 20-second log window.')

  const failed = await command('node -e "process.stderr.write(\'expected failure\');process.exit(3)"')
  assert.equal((await output(failed)).exitCode, 3)
  const shutdown = await successful(await request(`/api/sandboxes/${sandboxId}`, owner, 'DELETE'), 202)
  assert.equal(shutdown.stopped, false)
  const stopDeadline = Date.now() + 90_000
  let shutdownStatus
  while (Date.now() < stopDeadline) {
    shutdownStatus = await successful(await request(`/api/sandboxes/${sandboxId}`))
    if (shutdownStatus.status === 'stopped') break
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  assert.equal(shutdownStatus?.status, 'stopped')
  assert.equal(shutdownStatus?.shutdown?.saved, true)
  assert.equal((await request(`/api/sandboxes/${sandboxId}/cmds/${cmdId}/logs`)).status, 410)
  assert((await successful(await request(`/api/projects/${projectId}/files`))).files.some((file) => file.path === path))
  console.log('PASS: failed command status, expected expiry after stop, and durable source retained.')

  const expiredSandboxId = sandboxId
  const replacement = await successful(await request('/api/sandboxes', owner, 'POST', { projectId, ports: [3000], timeout: 600_000 }), 201)
  sandboxId = replacement.sandboxId
  assert.notEqual(sandboxId, expiredSandboxId)
  const source = (await successful(await request(`/api/projects/${projectId}/files`))).files
  await successful(await request(`/api/sandboxes/${sandboxId}/snapshot`, owner, 'PUT', { files: source.map(({ path, content, revision }) => ({ path, content, revision })) }))
  const restored = await successful(await request(`/api/sandboxes/${sandboxId}/snapshot`, owner, 'POST', { paths: [path] }))
  assert.equal(restored.files.find((file) => file.path === path)?.content, content)
  const resumed = await output(await command('node check.mjs'))
  assert.equal(resumed.exitCode, 0)
  assert(resumed.stdout === line.repeat(25000), 'Restored source must execute unchanged')
  console.log('PASS: expired sandbox replacement, saved-source restoration and successful execution after restore.')
} finally {
  // Confirmed deletion is the destructive cleanup path for this disposable
  // fixture. A 202 Stop receipt alone is not proof the VM has stopped.
  if (projectId && owner) {
    const removed = await request(`/api/projects/${projectId}`, owner, 'DELETE').catch(() => null)
    if (!removed?.ok) throw new Error('Live sandbox cleanup needs attention; ownership records were retained for recovery.')
  }
  for (const client of clients) await client.auth.signOut({ scope: 'local' }).catch(() => undefined)
  for (const id of users) {
    if ((await admin.auth.admin.deleteUser(id)).error) throw new Error('Temporary live-test account cleanup failed.')
  }
  console.log(`Cleaned up live test resources and ${users.length} temporary users.`)
}
