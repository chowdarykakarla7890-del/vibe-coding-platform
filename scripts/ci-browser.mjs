import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { setTimeout as pause } from 'node:timers/promises'
import { assertBrowserCiEnvironment, localEmailVerificationLink } from './browser-fixtures.mjs'
import { isolatedBuildEnvironment } from './ci-smoke.mjs'
import { checkBrowserEditor } from './check-browser-editor.mjs'
import { browserDiagnostic } from './browser-diagnostics.mjs'
import { isolatedAxeSource } from './browser-axe.mjs'
import { checkBrowserSecurity } from './check-browser-security.mjs'

assertBrowserCiEnvironment(process.env, readdirSync('.'))
const { chromium, expect } = await import('@playwright/test')
const { default: AxeBuilder } = await import('@axe-core/playwright')
const { createClient } = await import('@supabase/supabase-js')
const base = process.env.TEST_APP_URL
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } })
const users = [], contexts = [], diagnostics = []
let browser, stage = 'launch disposable Chromium'

async function step(name, run) {
  stage = name
  console.log(`Browser check: ${name}`)
  await run()
}

async function inboxLink(email, next) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const search = await fetch(`http://127.0.0.1:54324/api/v1/search?query=${encodeURIComponent(`to:${email}`)}&limit=5`, { signal: AbortSignal.timeout(5000) })
    if (!search.ok) throw new Error('Local inbox search failed.')
    const data = await search.json()
    const found = data.messages?.find(message => message.To?.some(recipient => recipient.Address === email))
    if (found) {
      assert.match(found.ID, /^[a-zA-Z0-9-]+$/)
      const response = await fetch(`http://127.0.0.1:54324/api/v1/message/${found.ID}`, { signal: AbortSignal.timeout(5000) })
      if (!response.ok) throw new Error('Local inbox message could not be read.')
      return localEmailVerificationLink(await response.json(), email, next)
    }
    await pause(300)
  }
  throw new Error('Local sign-in email did not arrive.')
}

async function actor(label) {
  const email = `codetutor-browser-${randomUUID()}-${label}@example.invalid`
  const created = await admin.auth.admin.createUser({ email, email_confirm: true })
  if (created.error || !created.data.user) throw new Error('Temporary browser account creation failed.')
  users.push(created.data.user.id)
  const context = await browser.newContext({ baseURL: base, viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
  contexts.push(context)
  context.setDefaultTimeout(10_000)
  context.setDefaultNavigationTimeout(20_000)
  // This test does not need any external browser traffic or paid service.
  await context.route(/^https?:/, route => {
    const origin = new URL(route.request().url()).origin
    return origin === base || origin === 'http://127.0.0.1:54321' ? route.continue() : route.abort('blockedbyclient')
  })
  const page = await context.newPage()
  page.on('pageerror', error => diagnostics.push({ actor: label, kind: 'pageerror', stage, ...browserDiagnostic(error.message, error.stack) }))
  page.on('console', message => {
    if (['error', 'warning'].includes(message.type())) diagnostics.push({ actor: label, kind: message.type(), stage, ...browserDiagnostic(message.text(), message.location().url) })
  })
  return { id: created.data.user.id, email, context, page }
}

async function signIn(account, next) {
  const { page } = account
  await page.goto(`/sign-in?next=${encodeURIComponent(next)}`)
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue with email', exact: true })).toBeEnabled()
  await scan(page, 'sign-in')
  await page.getByLabel('Email address').fill(account.email)
  await page.getByRole('button', { name: 'Continue with email', exact: true }).click()
  await expect(page.getByText('Check your inbox for a sign-in link.', { exact: false })).toBeVisible()
  const link = await inboxLink(account.email, next)
  // Never let Playwright print a one-time token in a failed navigation error.
  try { await page.goto(link) } catch { throw new Error('Local email verification navigation failed.') }
  await expect.poll(() => new URL(page.url()).pathname).toBe(new URL(next, base).pathname)
  await expect(page.locator('button[data-project-switcher-id]')).toBeVisible()
}

async function scan(page, label) {
  const results = await new AxeBuilder({ page, axeSource: isolatedAxeSource }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
  if (results.violations.length) console.error(JSON.stringify({ accessibility: label, violations: results.violations.map(item => ({ id: item.id, impact: item.impact, targets: item.nodes.map(node => node.target), contrast: item.nodes.flatMap(node => node.any.filter(check => check.id === 'color-contrast').map(check => ({ target: node.target, foreground: check.data?.fgColor, background: check.data?.bgColor, ratio: check.data?.contrastRatio, expected: check.data?.expectedContrastRatio }))) })) }))
  assert.equal(results.violations.length, 0, 'Automatically detectable WCAG A/AA issues must be fixed, not excluded.')
}

const switcher = page => page.locator('button[data-project-switcher-id]')
async function createProject(page, name) {
  await switcher(page).click()
  await page.getByRole('button', { name: 'New', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Create project', exact: true })
  await expect(dialog.getByLabel('Project name')).toBeFocused()
  assert.equal(await dialog.evaluate(element => getComputedStyle(element).animationName), 'none', 'Reduced-motion project dialogs must not animate.')
  await dialog.getByLabel('Project name').fill(name)
  await scan(page, 'create project dialog')
  await dialog.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await expect(switcher(page)).toHaveText(name)
  const id = await switcher(page).getAttribute('data-project-switcher-id')
  assert.match(id, /^[0-9a-f-]{36}$/)
  return id
}

async function chooseProject(page, title) {
  await switcher(page).click()
  await page.getByRole('button', { name: `${title} (playground)`, exact: true }).click()
  await expect(switcher(page)).toHaveText(title)
}

try {
  browser = await chromium.launch({ env: isolatedBuildEnvironment() })
  await step('production CSP enforcement and compatible script/frame loading', async () => {
    await checkBrowserSecurity({ browser, base, expect })
  })
  const a = await actor('a')
  const b = await actor('b')
  const titleA = 'Browser project A', titleB = 'Browser project B'
  let projectA, projectB
  await step('email delivery, PKCE callback and selected model for account A', async () => {
    await signIn(a, '/playground?modelId=openai/gpt-5-nano')
    await expect(a.page.getByRole('button', { name: 'GPT-5 nano', exact: true })).toBeVisible()
    await scan(a.page, 'desktop workspace')
  })
  await step('create and persist two projects through the UI', async () => {
    projectA = await createProject(a.page, titleA)
    projectB = await createProject(a.page, titleB)
    const saved = await admin.from('projects').select('id,title').eq('user_id', a.id).in('id', [projectA, projectB])
    assert.equal(saved.error, null)
    assert.equal(saved.data.length, 2)
  })
  await step('project-scoped persisted chat and reload', async () => {
    const seeded = await admin.from('messages').insert([
      { id: randomUUID(), user_id: a.id, project_id: projectA, role: 'assistant', parts: [{ type: 'text', text: 'Only project A contains this saved answer.' }], status: 'complete', model_id: 'openai/gpt-5-nano' },
      { id: randomUUID(), user_id: a.id, project_id: projectB, role: 'assistant', parts: [{ type: 'text', text: 'Only project B contains this saved answer.' }], status: 'complete', model_id: 'openai/gpt-5-nano' },
    ])
    assert.equal(seeded.error, null)
    await a.page.reload()
    await expect(switcher(a.page)).toHaveText(titleB)
    await expect(a.page.getByText('Only project B contains this saved answer.', { exact: true })).toBeVisible()
    await expect(a.page.getByText('Only project A contains this saved answer.', { exact: true })).toHaveCount(0)
    await chooseProject(a.page, titleA)
    await expect(a.page.getByText('Only project A contains this saved answer.', { exact: true })).toBeVisible()
    await expect(a.page.getByText('Only project B contains this saved answer.', { exact: true })).toHaveCount(0)
  })
  await step('rename project and preserve focus and model choice', async () => {
    await switcher(a.page).click()
    await a.page.getByRole('button', { name: 'Rename', exact: true }).click()
    const dialog = a.page.getByRole('dialog', { name: 'Rename project', exact: true })
    await expect(dialog.getByLabel('Project name')).toBeFocused()
    await dialog.getByLabel('Project name').fill('Renamed browser A')
    await dialog.getByRole('button', { name: 'Save name', exact: true }).click()
    await expect(switcher(a.page)).toHaveText('Renamed browser A')
    await expect(switcher(a.page)).toBeFocused()
    assert.equal(new URL(a.page.url()).searchParams.get('modelId'), 'openai/gpt-5-nano')
  })
  await step('pinned same-origin Monaco editing, diff, workers and stalled-download recovery', async () => {
    await checkBrowserEditor({ account: a, projectId: projectA, admin, base, expect, scan, phase: name => { stage = name } })
  })
  await step('desktop keyboard navigation and collapsed sidebar', async () => {
    await a.page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
    await a.page.getByRole('link', { name: 'Practice', exact: true }).focus()
    await a.page.keyboard.press('Enter')
    await expect.poll(() => new URL(a.page.url()).pathname).toBe('/practice')
    await expect(a.page.getByRole('link', { name: 'Practice', exact: true })).toHaveAttribute('aria-current', 'page')
    await scan(a.page, 'practice catalog')
    await a.page.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
    await a.page.getByRole('link', { name: 'Playground', exact: true }).click()
    await expect(switcher(a.page)).toHaveText('Renamed browser A')
  })
  await step('mobile drawer, workspace controls and reduced-motion layout', async () => {
    await a.page.setViewportSize({ width: 390, height: 844 })
    await expect(a.page.getByRole('button', { name: 'Open navigation', exact: true })).toBeVisible()
    await a.page.getByRole('button', { name: 'Open navigation', exact: true }).click()
    const drawer = a.page.getByRole('dialog', { name: 'Navigation', exact: true })
    await expect(drawer).toBeVisible()
    assert.equal(await drawer.evaluate(element => getComputedStyle(element).animationName), 'none', 'Reduced-motion navigation must not animate.')
    await scan(a.page, 'mobile navigation')
    await a.page.keyboard.press('Escape')
    await expect(drawer).not.toBeVisible()
    await expect(a.page.getByRole('button', { name: 'Open navigation', exact: true })).toBeFocused()
    await a.page.getByRole('button', { name: 'Workspace', exact: true }).click()
    await expect(a.page.getByRole('button', { name: 'Workspace', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await a.page.getByRole('button', { name: 'Tutor', exact: true }).click()
    assert(await a.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Mobile workspace must not overflow horizontally.')
    await scan(a.page, 'mobile tutor')
    await a.page.setViewportSize({ width: 1440, height: 1000 })
  })
  await step('second account has no access to first account projects or messages', async () => {
    await signIn(b, '/playground')
    await switcher(b.page).click()
    await expect(b.page.getByRole('button', { name: 'Renamed browser A (playground)', exact: true })).toHaveCount(0)
    await b.page.keyboard.press('Escape')
    const denied = await b.context.request.get(`${base}/api/projects/${projectA}/messages`)
    assert.equal(denied.status(), 404)
    const body = await denied.json()
    assert.equal(body.error.code, 'PROJECT_NOT_FOUND')
    await expect(b.page.getByText('Only project A contains this saved answer.', { exact: true })).toHaveCount(0)
  })
  await step('confirmed project deletion removes only its own persisted history', async () => {
    await chooseProject(a.page, titleB)
    await switcher(a.page).click()
    await a.page.getByRole('button', { name: 'Delete project', exact: true }).click()
    const dialog = a.page.getByRole('dialog', { name: 'Delete project?', exact: true })
    await scan(a.page, 'delete project dialog')
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(switcher(a.page)).toHaveText(titleB)
    await switcher(a.page).click()
    await a.page.getByRole('button', { name: 'Delete project', exact: true }).click()
    await dialog.getByRole('button', { name: 'Delete project', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    await expect.poll(async () => (await admin.from('projects').select('id').eq('id', projectB)).data?.length).toBe(0)
    const history = await admin.from('messages').select('id').eq('project_id', projectB)
    assert.equal(history.error, null)
    assert.equal(history.data.length, 0)
    const retained = await admin.from('projects').select('id').eq('id', projectA)
    assert.equal(retained.data.length, 1)
  })
  await step('confirmed sign-out removes access without affecting the other account', async () => {
    await a.page.getByRole('button', { name: 'Sign out', exact: true }).click()
    const dialog = a.page.getByRole('dialog', { name: 'Sign out of CodeTutor?', exact: true })
    await scan(a.page, 'sign-out dialog')
    await dialog.getByRole('button', { name: 'Confirm sign-out', exact: true }).click()
    await expect.poll(() => new URL(a.page.url()).pathname).toBe('/sign-in')
    assert.equal((await a.context.request.get(`${base}/api/projects`)).status(), 401)
    await a.page.goto('/playground')
    await expect.poll(() => new URL(a.page.url()).pathname).toBe('/sign-in')
    await b.page.reload()
    await expect(switcher(b.page)).toBeVisible()
    assert.equal((await b.context.request.get(`${base}/api/projects`)).status(), 200)
  })
  await step('no hydration, update-loop, console or uncaught page errors', async () => {
    if (diagnostics.length) console.error(JSON.stringify({ browserDiagnostics: diagnostics }))
    assert.equal(diagnostics.length, 0)
  })
  console.log('PASS: real local email/PKCE sign-in, project/chat isolation, confirmed deletion/sign-out, keyboard/mobile navigation and automated accessibility checks.')
} catch (error) {
  // Do not print Playwright navigation errors: they may contain an OTP URL.
  console.error(`Browser verification failed during: ${stage}. No authentication URLs, cookies or provider payloads are logged.`)
  // Fixed diagnostics only; never echo the original exception or its cause.
  const safeFailures = ['Local inbox search failed.', 'Local inbox message could not be read.', 'Local sign-in email did not arrive.', 'Local email has no matching loopback verification link.', 'Local email does not belong to this fixture.', 'Local email verification navigation failed.', 'Temporary browser account creation failed.']
  if (safeFailures.includes(error?.message)) console.error(error.message)
  else console.error(`Failure category: ${error?.name === 'AssertionError' ? 'assertion' : error?.name === 'TimeoutError' ? 'timeout' : 'browser operation'}.`)
  process.exitCode = 1
} finally {
  for (const context of contexts) await context.close().catch(() => undefined)
  await browser?.close().catch(() => undefined)
  let cleanupFailed = false
  for (const id of users) {
    try {
      const { error } = await admin.auth.admin.deleteUser(id)
      if (error) cleanupFailed = true
    } catch { cleanupFailed = true }
  }
  if (cleanupFailed) { console.error('Temporary browser-account cleanup failed.'); process.exitCode = 1 }
  else console.log(`Cleaned up ${users.length} temporary browser accounts.`)
}
