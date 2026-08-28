// Opt-in: eight paid AI requests, two disposable accounts and one owned VM.
// Run only against a local Next dev server; BotID still needs a Vercel check.
// Prints IDs, status and timings only, never credentials or model content.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { setTimeout as pause } from 'node:timers/promises'
import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import { readUIMessageStream } from 'ai'

const base = process.env.TEST_APP_URL ?? 'http://localhost:3112'
assert(['localhost', '127.0.0.1'].includes(new URL(base).hostname), 'Local application URL required')
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const publicKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
const secret = process.env.SUPABASE_SECRET_KEY
assert(url && publicKey && secret, 'Load the Supabase configuration first')
const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } })
const users = []
const clients = []
const results = []
const expectCreditsExhausted = process.env.TEST_EXPECT_CREDITS_EXHAUSTED === '1'
let owner
let projectId
let sandboxId
const models = [
  'anthropic/claude-opus-4.6', 'anthropic/claude-sonnet-4.6',
  'openai/gpt-5.3-codex', 'xai/grok-4.1-fast-reasoning',
  'deepseek/deepseek-v4-flash', 'openai/gpt-5-nano',
  'google/gemini-3.1-flash-lite', 'mistral/devstral-small-2',
]

async function account() {
  const email = `codetutor-model-check-${randomUUID()}@example.invalid`
  const password = randomBytes(24).toString('hex')
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  assert(!error && data.user, 'Temporary account creation failed')
  users.push(data.user.id)
  const cookies = new Map()
  const client = createServerClient(url, publicKey, { cookies: {
    getAll: () => [...cookies].map(([name, value]) => ({ name, value })),
    setAll: entries => entries.forEach(({ name, value }) => cookies.set(name, value)),
  } })
  clients.push(client)
  assert(!(await client.auth.signInWithPassword({ email, password })).error, 'Temporary sign-in failed')
  return { id: data.user.id, cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') }
}

function request(path, user = owner, method = 'GET', body, signal = AbortSignal.timeout(65_000)) {
  return fetch(new URL(path, base), { method, signal, redirect: 'manual', headers: {
    ...(user ? { cookie: user.cookie, 'X-CodeTutor-Account': user.id } : {}),
    ...(method !== 'GET' ? { origin: base, 'content-type': 'application/json' } : {}),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
async function successful(response, expected = 200) {
  assert(response.status === expected, `Unexpected HTTP status: ${response.status}`)
  return response.json()
}
async function savedAssistant(id) {
  assert(id, 'Missing reserved assistant ID')
  let saved
  for (let attempt = 0; attempt < 12; attempt++) {
    saved = (await successful(await request(`/api/projects/${projectId}/messages`))).messages.find(row => row.id === id)
    if (saved && saved.status !== 'pending') break
    await pause(250)
  }
  return saved
}

function chunks(response, metrics, startedAt) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let bytes = 0
  return new ReadableStream({
    async pull(controller) {
      try {
        while (true) {
          const boundary = buffer.indexOf('\n\n')
          if (boundary !== -1) {
            const event = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')
            if (!data) continue
            if (data === '[DONE]') { metrics.done = true; continue }
            const part = JSON.parse(data)
            metrics.events++
            if (part.type === 'start') { metrics.startMs = Date.now() - startedAt; metrics.assistantId = part.messageId }
            if (part.type === 'text-delta' || part.type === 'reasoning-delta' || part.type === 'tool-input-start') metrics.firstOutputMs ??= Date.now() - startedAt
            if (part.type === 'tool-input-available') metrics.toolCalls++
            if (part.type === 'finish') metrics.finish = part.finishReason ?? 'unknown'
            if (['error', 'abort', 'tool-output-error', 'tool-input-error'].includes(part.type)) metrics.failureType = part.type
            if (part.type === 'error') metrics.creditGuidance = typeof part.errorText === 'string' && part.errorText.includes('out of credits')
            controller.enqueue(part)
            return
          }
          const next = await reader.read()
          if (next.done) {
            assert(!buffer.trim(), 'Incomplete final SSE event')
            controller.close()
            return
          }
          bytes += next.value.byteLength
          assert(bytes <= 1024 * 1024, 'Stream exceeded the test output limit')
          buffer += decoder.decode(next.value, { stream: true })
        }
      } catch (error) {
        await reader.cancel().catch(() => undefined)
        controller.error(error)
      }
    },
    async cancel() { await reader.cancel().catch(() => undefined) },
  })
}

try {
  const catalog = await successful(await request('/api/models', null))
  assert.deepEqual(catalog.models.map(model => model.id), models)
  assert.deepEqual(catalog.models.map(model => model.tier), [...Array(4).fill('primary'), ...Array(4).fill('affordable')])
  owner = await account()
  const other = await account()
  projectId = (await successful(await request('/api/projects', owner, 'POST', { title: 'Disposable live model matrix' }), 201)).project.id
  const body = { projectId, message: { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: 'Explain a loop.' }] }, modelId: models[0] }
  assert.equal((await request('/api/chat', null, 'POST', body)).status, 401)
  assert.equal((await request('/api/chat', other, 'POST', body)).status, 404)
  const unsupported = await request('/api/chat', owner, 'POST', { ...body, modelId: 'unknown/not-supported' })
  assert.equal(unsupported.status, 400)
  assert.equal((await unsupported.json()).error.code, 'UNSUPPORTED_MODEL')
  assert.equal((await request(`/api/projects/${projectId}/messages`, other)).status, 404)
  console.log('PASS: model ordering, unauthorized chat, cross-user history and unsupported-model rejection')

  sandboxId = (await successful(await request('/api/sandboxes', owner, 'POST', { projectId, ports: [3000], timeout: 1_800_000 }), 201)).sandboxId
  const path = 'model-check.mjs'
  let revision = null
  const selectedModels = expectCreditsExhausted ? ['openai/gpt-5-nano'] : models
  for (const modelId of selectedModels) {
    const startedAt = Date.now()
    const metrics = { modelId, events: 0, toolCalls: 0 }
    let stage = 'source'
    try {
      const value = randomBytes(8).toString('hex')
      const receipt = await successful(await request(`/api/sandboxes/${sandboxId}/files`, owner, 'PUT', {
        path, content: `export const CHECK_VALUE = ${JSON.stringify(value)};\n`, revision,
      }))
      revision = receipt.revision
      stage = 'stream'
      const requestStartedAt = Date.now()
      const response = await request('/api/chat', owner, 'POST', {
        projectId, modelId, reasoningEffort: 'low', message: { id: randomUUID(), role: 'user', parts: [{ type: 'text',
          text: 'This is a read-only JavaScript learning check. The file model-check.mjs was changed since the last turn. Use readFiles exactly once to read its CURRENT content in this project sandbox, then tell me its CHECK_VALUE in one short sentence. Do not create, edit or execute any files, and do not use any other tools.',
        }] },
      }, AbortSignal.timeout(150_000))
      assert(response.ok && response.body, `Chat HTTP ${response.status}`)
      assert.equal(response.headers.get('x-vercel-ai-ui-message-stream'), 'v1')
      assert(response.headers.get('x-request-id'), 'Missing request ID')
      let message
      for await (const update of readUIMessageStream({ stream: chunks(response, metrics, requestStartedAt), terminateOnError: true })) message = update
      assert(metrics.done && metrics.finish === 'stop' && !metrics.failureType, 'Chat did not complete normally')
      assert(message?.id === metrics.assistantId, 'Assistant ID changed')
      const called = message.parts.filter(part => part.type.startsWith('tool-'))
      assert(called.length === 1 && called[0].type === 'tool-readFiles' && called[0].state === 'output-available', 'Expected exactly one completed readFiles tool')
      assert(called[0].input.sandboxId === sandboxId && called[0].input.paths.length === 1 && called[0].input.paths[0] === path, 'Tool used incorrect sandbox or path')
      assert(typeof called[0].output === 'string' && called[0].output.includes(value), 'Tool did not return current source')
      const text = message.parts.filter(part => part.type === 'text').map(part => part.text).join('\n')
      assert(text.includes(value), 'Assistant used stale source instead of tool result')
      stage = 'persistence'
      const saved = await savedAssistant(message.id)
      assert(saved?.status === 'complete' && saved.model_id === modelId, 'Assistant completion was not saved')
      assert(JSON.stringify(saved.parts) === JSON.stringify(message.parts), 'Saved message parts differ from streamed parts')
      metrics.status = 'passed'
    } catch (error) {
      metrics.status = 'failed'
      metrics.stage = stage
      metrics.errorName = error instanceof Error ? error.name : 'UnknownError'
      // Only our fixed assertion labels are safe to expose; SDK errors can
      // include model/provider payloads. Never print arbitrary error messages.
      if (error instanceof assert.AssertionError && !error.generatedMessage) metrics.check = error.message
      if (metrics.assistantId) {
        const saved = await savedAssistant(metrics.assistantId)
        metrics.persistenceStatus = saved?.status ?? 'missing'
        if (expectCreditsExhausted && metrics.creditGuidance && saved?.status === 'failed') {
          assert(saved.model_id === modelId, 'Failed response lost its model ID')
          const source = await successful(await request(`/api/projects/${projectId}/files`))
          assert(source.files.some(file => file.path === path && file.revision === revision), 'AI failure discarded saved source')
          metrics.status = 'expected-service-unavailable'
        }
      }
    }
    metrics.durationMs = Date.now() - startedAt
    results.push(metrics)
    console.log('Live model result', metrics)
  }
  if (expectCreditsExhausted) assert(results.length === 1 && results[0].status === 'expected-service-unavailable', 'Expected live credit-exhaustion guidance and a saved failed turn')
  else assert(results.length === 8 && results.every(result => result.status === 'passed'), 'Live model matrix has failures')
} finally {
  // Stop only this fixture's VMs through authenticated project deletion. Do
  // not delete ownership rows if VM cleanup cannot be confirmed.
  if (projectId && owner) {
    const removed = await request(`/api/projects/${projectId}`, owner, 'DELETE').catch(() => null)
    assert(removed?.ok, 'Fixture cleanup needs attention; ownership records retained')
  }
  for (const client of clients) await client.auth.signOut({ scope: 'global' }).catch(() => undefined)
  for (const id of users) assert(!(await admin.auth.admin.deleteUser(id)).error, 'Temporary account cleanup failed')
  console.log('Cleaned up model-matrix project, sandbox and temporary users', { users: users.length, results: results.length })
}
