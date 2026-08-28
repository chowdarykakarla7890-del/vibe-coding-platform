// Hosted integration test: creates only temporary users and deletes them in
// finally. No emails are sent; no AI calls or sandboxes are created.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import { checkLearningHistory } from './check-learning-history.mjs'
import { checkCommandReservations } from './check-command-reservations.mjs'
import { checkSourceRevisions } from './check-source-revisions.mjs'
import { checkSourceDeletions } from './check-source-deletions.mjs'
import { checkSourceReview } from './check-source-review.mjs'
import { checkActivitySubmissions } from './check-activity-submissions.mjs'
import { checkProjectArchives } from './check-project-archives.mjs'
import { checkSourceImports } from './check-source-imports.mjs'

const base = process.env.TEST_APP_URL ?? 'http://localhost:3010'
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('Run this test against a local application only.')
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const publicKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
const secret = process.env.SUPABASE_SECRET_KEY
if (!url || !publicKey || !secret) throw new Error('Load the configured Supabase environment first.')
const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } })
const users = []
const clients = []

// This runner never launches VMs. Durable cleanup tombstones intentionally
// survive project/user deletion, so settle only this runner's synthetic jobs.
// Do not use this helper in a live-Sandbox test or against existing accounts.
async function settleDatabaseOnlyFixtureCleanup(userId) {
  assert(users.includes(userId), 'Cleanup requires an account created by this test run')
  const jobs = await admin.from('sandbox_cleanup_jobs').select('id,sandbox_name,state').eq('user_id', userId)
  assert.equal(jobs.error, null)
  for (const job of jobs.data) {
    assert(job.sandbox_name === `codetutor-${job.id}` || /^(test-only-|submission-test-|sbx_test_)[0-9a-f-]{36}$/.test(job.sandbox_name), 'Refusing cleanup for an unrecognized sandbox handle')
    assert.notEqual(job.state, 'leased', 'A worker owns this test tombstone; do not override its lease')
    const completed = await admin.from('sandbox_cleanup_jobs').update({ state: 'complete', outcome: 'not_started' })
      .eq('id', job.id).eq('user_id', userId).neq('state', 'leased').select('id')
    assert.equal(completed.error, null)
    assert.equal(completed.data.length, 1)
  }
  return jobs.data.length
}

async function account(label) {
  const email = `codetutor-smoke-${randomUUID()}-${label}@example.invalid`
  // Supabase Auth uses bcrypt, whose input is limited to 72 bytes.
  const password = randomBytes(24).toString('hex')
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (error) throw new Error(`Test user creation failed (${error.status ?? 'unknown'}).`)
  users.push(data.user.id)
  const cookies = new Map()
  const client = createServerClient(url, publicKey, { cookies: {
    getAll: () => [...cookies].map(([name, value]) => ({ name, value })),
    setAll: (values) => values.forEach(({ name, value }) => cookies.set(name, value)),
  } })
  clients.push(client)
  const result = await client.auth.signInWithPassword({ email, password })
  if (result.error) throw new Error(`Test sign-in failed (${result.error.status ?? 'unknown'}).`)
  return { id: data.user.id, client, cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') }
}

async function request(path, account, method = 'GET', body, origin = base, headers = {}) {
  return fetch(new URL(path, base), { method, redirect: 'manual', signal: AbortSignal.timeout(20_000), headers: {
    ...(account ? { cookie: account.cookie } : {}),
    ...(method !== 'GET' ? { origin, 'content-type': 'application/json' } : {}),
    ...headers,
  }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) })
}

try {
  const a = await account('a')
  const b = await account('b')
  await checkSourceImports({ admin, request, a, b })
  await checkProjectArchives({ admin, request, a, b })
  await checkActivitySubmissions({ admin, request, a, b })
  await checkSourceReview({ admin, request, a, b })
  await checkLearningHistory({ admin, request, a, b })
  await checkCommandReservations({ admin, a, b })
  await settleDatabaseOnlyFixtureCleanup(a.id)
  await settleDatabaseOnlyFixtureCleanup(b.id)
  assert.equal((await request('/api/projects')).status, 401)
  assert.equal((await request('/api/chat', undefined, 'POST', {})).status, 401)
  assert.equal((await request('/api/sandboxes', undefined, 'POST', {})).status, 401)
  const created = await request('/api/projects', a, 'POST', { title: 'Temporary isolation check' })
  assert.equal(created.status, 201)
  const { project } = await created.json()
  assert.equal(project.user_id, a.id)
  // Only database records are created below, never paid sandbox VMs or AI calls.
  const parts = [{ type: 'text', text: 'Temporary durable message' }]
  const turn = { p_user_id: a.id, p_project_id: project.id, p_message_id: randomUUID(), p_parts: parts, p_model_id: 'openai/gpt-5-nano', p_request_id: randomUUID(), p_retry: false }
  const deniedTurn = await a.client.rpc('begin_chat_turn', turn)
  assert(deniedTurn.error, 'Browsers must not invoke privileged chat reservation functions')
  const crossUserTurn = await admin.rpc('begin_chat_turn', { ...turn, p_user_id: b.id })
  assert.equal(crossUserTurn.error?.message, 'PROJECT_NOT_FOUND')
  const concurrentTurns = await Promise.all([admin.rpc('begin_chat_turn', turn), admin.rpc('begin_chat_turn', { ...turn, p_request_id: randomUUID() })])
  assert.equal(concurrentTurns.filter((result) => !result.error).length, 1)
  assert(concurrentTurns.some((result) => result.error?.message === 'CHAT_BUSY'))
  const assistantId = concurrentTurns.find((result) => !result.error).data
  const messagesPath = `/api/projects/${project.id}/messages`
  const ownMessages = await (await request(messagesPath, a)).json()
  assert.equal(ownMessages.messages.length, 2)
  assert.deepEqual(ownMessages.messages[0].parts, parts)
  assert.equal(ownMessages.messages[1].status, 'pending')
  assert.equal((await request(messagesPath, b)).status, 404)
  assert.equal((await b.client.from('messages').select('id').eq('project_id', project.id)).data.length, 0)
  assert.equal((await request(`${messagesPath}/stop`, b, 'POST', { messageId: assistantId })).status, 404)
  assert.equal((await request(`${messagesPath}/stop`, a, 'POST', { messageId: assistantId })).status, 200)
  const retryRequestId = randomUUID()
  const retryTurn = await admin.rpc('begin_chat_turn', { ...turn, p_retry: true, p_request_id: retryRequestId })
  assert.equal(retryTurn.error, null)
  assert.equal(retryTurn.data, assistantId, 'Retry must replace the response without duplicating the user message')
  const staleWrite = await admin.from('messages').update({ parts: [{ type: 'text', text: 'stale' }] }).eq('project_id', project.id).eq('id', assistantId).eq('request_id', turn.p_request_id).select('id')
  assert.equal(staleWrite.data.length, 0, 'Late completions must be fenced by request ID')
  await admin.from('messages').update({ status: 'complete', parts: [{ type: 'text', text: 'Durable answer' }] }).eq('project_id', project.id).eq('id', assistantId)
  assert.equal((await admin.rpc('begin_chat_turn', { ...turn, p_request_id: randomUUID() })).error?.message, 'MESSAGE_EXISTS')
  assert.equal((await admin.rpc('begin_chat_turn', { ...turn, p_retry: true, p_parts: [{ type: 'text', text: 'forged replacement' }] })).error?.message, 'MESSAGE_CONFLICT')
  const reservation = { p_user_id: a.id, p_project_id: project.id, p_ports: [3000] }
  assert((await a.client.rpc('reserve_sandbox_session', reservation)).error)
  const races = await Promise.all([admin.rpc('reserve_sandbox_session', reservation), admin.rpc('reserve_sandbox_session', reservation)])
  assert.equal(races.filter((result) => !result.error).length, 1, 'Exactly one sandbox reservation must win after synthetic cleanup jobs are settled')
  assert(races.some((result) => result.error?.message === 'PROJECT_SANDBOX_ACTIVE'))
  const sessionId = races.find((result) => !result.error).data
  const fakeSandboxId = `sbx_test_${randomUUID()}`
  assert.equal((await admin.from('sandbox_sessions').update({ sandbox_id: fakeSandboxId, status: 'expired', expires_at: new Date(Date.now() - 1000).toISOString() }).eq('id', sessionId)).error, null)
  // Complete the never-launched reservation before the real DELETE endpoint
  // schedules its after-response cleanup worker. Otherwise it can lease a
  // synthetic handle concurrently with this database-only runner's teardown.
  await settleDatabaseOnlyFixtureCleanup(a.id)
  const linkedProject = await (await request(`/api/projects/${project.id}`, a)).json()
  assert.equal(linkedProject.project.sandbox_sessions[0].sandbox_id, fakeSandboxId)
  assert.equal((await request(`/api/sandboxes/${fakeSandboxId}`, a)).status, 410)
  assert.equal((await request(`/api/sandboxes/${fakeSandboxId}`, b)).status, 404)
  assert.equal((await request(`/api/sandboxes/${fakeSandboxId}/snapshot`, b, 'PUT', { files: [{ path: 'a.ts', content: 'blocked' }] })).status, 404)
  const projectFiles = `/api/projects/${project.id}/files`
  const savedViaApi = await request(projectFiles, a, 'PUT', { files: Array.from({ length: 25 }, (_, index) => ({ path: `src/api-${String(index).padStart(2, '0')}.ts`, content: `export const value = ${index}` })) })
  assert.equal(savedViaApi.status, 200)
  assert.equal(savedViaApi.headers.get('x-ratelimit-limit'), '120')
  const expiredFilePath = `/api/sandboxes/${fakeSandboxId}/files?path=src/api-00.ts`
  const expiredSource = await request(expiredFilePath, a)
  assert.equal(expiredSource.status, 200, 'Saved source must remain readable after expiration without contacting a VM')
  assert.equal(expiredSource.headers.get('x-source-revision'), '1')
  assert.equal(await expiredSource.text(), 'export const value = 0')
  assert.equal((await request(expiredFilePath, b)).status, 404, 'Another account cannot read expired source')
  assert.equal((await request(expiredFilePath)).status, 401)
  assert.equal((await request(`/api/sandboxes/${fakeSandboxId}/files`, a, 'PUT', { path: 'src/api-00.ts', content: 'blocked', revision: 1 })).status, 410, 'Expired source access must not enable VM mutations')
  console.log('PASS: expired saved-source reads, two-user isolation, and live-only mutation checks.')
  const firstFiles = await (await request(projectFiles, a)).json()
  assert.equal(firstFiles.files.length, 20)
  assert(firstFiles.nextCursor)
  const nextFiles = await (await request(`${projectFiles}?after=${encodeURIComponent(firstFiles.nextCursor)}`, a)).json()
  assert.equal(nextFiles.files.length, 5)
  assert.equal(nextFiles.nextCursor, null)
  assert.equal((await request(projectFiles, b)).status, 404)
  assert.equal((await request(projectFiles, b, 'PUT', { files: [{ path: 'stolen.ts', content: 'blocked' }] })).status, 404)
  assert.equal((await request(projectFiles, a, 'PUT', { files: [{ path: '../secret', content: 'blocked' }] })).status, 400)
  const portfolio = { id: 'default', displayName: 'Temporary portfolio', headline: '', bio: '', skills: [], projects: [], updatedAt: Date.now() }
  assert.equal((await request('/api/portfolio', a, 'PUT', portfolio)).status, 200)
  assert.equal((await (await request('/api/portfolio', a)).json()).portfolio.displayName, portfolio.displayName)
  assert.equal((await (await request('/api/portfolio', b)).json()).portfolio, null)
  const ownList = await (await request('/api/projects', a)).json()
  assert(ownList.projects.some((row) => row.id === project.id))
  const otherList = await (await request('/api/projects', b)).json()
  assert(!otherList.projects.some((row) => row.id === project.id))
  await checkSourceRevisions({ admin, request, a, b, projectId: project.id })
  await checkSourceDeletions({ admin, request, a, b, projectId: project.id, sandboxId: fakeSandboxId })
  const hidden = await b.client.from('source_files').select('path').eq('project_id', project.id)
  assert.equal(hidden.data.length, 0)
  const reassigned = await a.client.from('source_files').update({ user_id: b.id }).eq('project_id', project.id)
  assert(reassigned.error, 'Source ownership must not be reassignable')
  const forgedSandbox = await a.client.from('sandbox_sessions').insert({ user_id: a.id, project_id: project.id, sandbox_id: 'forged', expires_at: new Date(Date.now()+60000).toISOString() })
  assert(forgedSandbox.error, 'Clients must not register sandbox ownership')
  assert.equal((await request(`/api/projects/${project.id}`, b, 'PATCH', { title: 'Blocked' })).status, 404)
  assert.equal((await request(`/api/projects/${project.id}`, a, 'PATCH', { user_id: b.id })).status, 400)
  assert.equal((await request('/api/projects', a, 'POST', '{')).status, 400)
  assert.equal((await request('/api/projects', a, 'POST', { title: 'Blocked' }, 'https://evil.invalid')).status, 403)
  assert.equal((await request(`/api/projects/${project.id}`, a, 'DELETE')).status, 200)
  const remainingFiles = await admin.from('source_files').select('path').eq('project_id', project.id)
  assert.equal(remainingFiles.data.length, 0, 'Project deletion must cascade source files')
  assert.equal((await request('/playground')).status, 307)
  assert.equal((await request('/sign-in')).status, 200)
  assert.equal((await request('/auth/sign-out')).status, 405, 'A sign-out GET must not be redirected into a mutation')
  assert.equal((await request('/auth/sign-out', a, 'POST', undefined, 'https://evil.invalid')).status, 403)
  const jsonSignOutHeaders = { accept: 'application/json', 'X-CodeTutor-Account': a.id }
  assert.equal((await request('/auth/sign-out', a, 'POST', undefined, base, { accept: 'application/json' })).status, 400)
  const staleSignOut = await request('/auth/sign-out', b, 'POST', undefined, base, jsonSignOutHeaders)
  assert.equal(staleSignOut.status, 409)
  assert.equal((await staleSignOut.json()).error.code, 'ACCOUNT_CHANGED')
  assert(!/max-age=0/i.test(staleSignOut.headers.get('set-cookie') ?? ''), 'Stale sign-out must not clear the other account cookies')
  assert.equal((await request('/playground', b)).status, 200, 'The other account remains accessible after denial')
  const anonymousSignOut = await request('/auth/sign-out', undefined, 'POST')
  assert.equal(anonymousSignOut.status, 303, 'Anonymous sign-out must reach its own handler, not a proxy POST redirect')
  assert.equal(new URL(anonymousSignOut.headers.get('location'), base).pathname, '/sign-in')
  assert.equal((await request('/playground', a)).status, 200)
  const resumedSignIn = await request('/sign-in?next=%2Fdsa%3Flanguage%3Dpython', a)
  assert.equal(resumedSignIn.status, 307)
  // Next may serialize a same-origin redirect as a relative Location header.
  assert.equal(new URL(resumedSignIn.headers.get('location'), base).toString(), new URL('/dsa?language=python', base).toString())
  const failedCallback = await request('/auth/callback?error=access_denied&next=%2Fplayground%3FmodelId%3Dopenai%2Fgpt-5-nano')
  assert.equal(failedCallback.status, 307)
  const retryLocation = new URL(failedCallback.headers.get('location'), base)
  assert.equal(retryLocation.origin, new URL(base).origin)
  assert.equal(retryLocation.pathname, '/sign-in')
  assert.equal(retryLocation.searchParams.get('next'), '/playground?modelId=openai/gpt-5-nano')
  assert.equal(failedCallback.headers.get('cache-control'), 'private, no-store')
  console.log('PASS: real cookie-authenticated sign-in resumption and callback failure preserve safe destinations.')
  assert.equal((await admin.from('messages').select('id').eq('project_id', project.id)).data.length, 0)
  assert.equal((await admin.from('sandbox_sessions').select('id').eq('project_id', project.id)).data.length, 0)
  const signedOut = await request('/auth/sign-out', a, 'POST')
  assert.equal(signedOut.status, 303)
  assert.equal(new URL(signedOut.headers.get('location'), base).pathname, '/sign-in')
  assert.match(signedOut.headers.get('set-cookie') ?? '', /max-age=0/i, 'Successful sign-out must clear browser session cookies')
  const jsonSignedOut = await request('/auth/sign-out', b, 'POST', undefined, base, { ...jsonSignOutHeaders, 'X-CodeTutor-Account': b.id })
  assert.equal(jsonSignedOut.status, 200)
  assert.deepEqual(await jsonSignedOut.json(), { signedOut: true })
  assert.equal(jsonSignedOut.headers.get('location'), null)
  assert.equal(jsonSignedOut.headers.get('cache-control'), 'private, no-store')
  assert(jsonSignedOut.headers.get('x-request-id'))
  assert.match(jsonSignedOut.headers.get('set-cookie') ?? '', /max-age=0/i)
  const retriedSignOut = await request('/auth/sign-out', undefined, 'POST', undefined, base, jsonSignOutHeaders)
  assert.equal(retriedSignOut.status, 200)
  assert.deepEqual(await retriedSignOut.json(), { signedOut: true })
  console.log('PASS: sign-out identity checks, JSON/native receipts, CSRF rejection, GET refusal and acknowledged cookie removal.')
  console.log('PASS: hosted cookie auth, durable projects/source/chat/portfolio, atomic chat and sandbox reservations, retry fencing, expiration, two-user isolation, private functions, validation, CSRF, and cascade deletion.')
} finally {
  for (const client of clients) await client.auth.signOut({ scope: 'local' }).catch(() => undefined)
  let cleanupFailed = false
  for (const id of users) {
    try { await settleDatabaseOnlyFixtureCleanup(id) }
    catch { cleanupFailed = true }
    const { error } = await admin.auth.admin.deleteUser(id)
    if (error) cleanupFailed = true
  }
  if (cleanupFailed) throw new Error('Temporary user cleanup failed; inspect the Supabase test accounts.')
  console.log(`Cleaned up ${users.length} temporary test users; synthetic sandbox cleanup jobs are settled as not started.`)
}
