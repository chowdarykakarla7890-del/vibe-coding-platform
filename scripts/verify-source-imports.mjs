// Disposable account/database test. No email, AI requests or VMs.
import assert from 'node:assert/strict'
import { randomUUID, randomBytes } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import { checkSourceImports } from './check-source-imports.mjs'

const base = process.env.TEST_APP_URL ?? 'http://localhost:3112'
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('Run only against a local app.')
const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
if (!url || !key || !process.env.SUPABASE_SECRET_KEY) throw new Error('Load the configured Supabase environment.')
const admin = createClient(url, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
const users = [], clients = []
async function account() {
  const email = `source-import-${randomUUID()}@example.invalid`, password = randomBytes(24).toString('hex')
  const result = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (result.error) throw new Error('Temporary account could not be created.')
  users.push(result.data.user.id)
  const cookies = new Map()
  const client = createServerClient(url, key, { cookies: {
    getAll: () => [...cookies].map(([name, value]) => ({ name, value })),
    setAll: values => values.forEach(({ name, value }) => cookies.set(name, value)),
  } })
  clients.push(client)
  if ((await client.auth.signInWithPassword({ email, password })).error) throw new Error('Temporary sign-in failed.')
  return { id: result.data.user.id, client, cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') }
}
async function request(path, account, method = 'GET', body, origin = base) {
  return fetch(new URL(path, base), { method, redirect: 'manual', signal: AbortSignal.timeout(25_000), headers: {
    ...(account ? { cookie: account.cookie, 'X-CodeTutor-Account': account.id } : {}),
    ...(method !== 'GET' ? { origin, 'content-type': 'application/json' } : {}),
  }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) })
}
try {
  const a = await account(), b = await account()
  await checkSourceImports({ admin, request, a, b })
} finally {
  for (const client of clients) assert.equal((await client.auth.signOut({ scope: 'global' })).error, null)
  for (const id of users) assert.equal((await admin.auth.admin.deleteUser(id)).error, null)
  console.log('Disposable source-import accounts and projects removed; temporary sessions signed out.')
}
