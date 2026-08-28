import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'

/** Real editor assets + authenticated saved-source reads. Only VM status is
 * simulated; no sandbox is provisioned, and file mutation APIs are forbidden.
 * Run exclusively from ci-browser.mjs after its disposable-environment guard.
 */
export async function checkBrowserEditor({ account, projectId, admin, base, expect, scan }) {
  const { page } = account
  const sandboxId = `test-only-${randomUUID()}`
  const path = 'editor-check.ts'
  const original = 'export const answer: number = 41;\n'
  const modified = 'export const answer: number = 42;\n'
  const prefix = `/api/sandboxes/${sandboxId}`
  const pin = createRequire(import.meta.url)('../package.json').dependencies['monaco-editor']
  const assetPrefix = `/vendor/monaco/${pin}/vs/`
  const assets = new Set(), workers = new Set()
  const watchRequest = request => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/vendor/monaco/') || /monaco-editor/.test(url.href)) assets.add(url.href)
  }
  const watchWorker = worker => workers.add(worker.url())
  page.on('request', watchRequest); page.on('worker', watchWorker)
  const vmRoute = async route => {
    const request = route.request(), url = new URL(request.url())
    if (url.pathname === prefix && request.method() === 'GET') return route.fulfill({ json: { status: 'running' } })
    if (url.pathname === `${prefix}/files` && request.method() === 'GET') return route.fallback()
    throw new Error('Browser editor fixture must not invoke paid VM operations or mutate source.')
  }
  await page.route(`${base}${prefix}**`, vmRoute)
  let releaseLoader
  const loaderRoute = async route => {
    await new Promise(resolve => { releaseLoader = resolve })
    await route.continue()
  }
  try {
    console.log('Editor check: seed disposable owned source and synthetic expired registration.')
    const session = await admin.from('sandbox_sessions').insert({ user_id: account.id, project_id: projectId,
      sandbox_id: sandboxId, status: 'expired', expires_at: new Date(Date.now() - 60_000).toISOString() })
    assert.equal(session.error, null)
    const source = await admin.rpc('save_source_revision_batch', { p_user_id: account.id, p_project_id: projectId,
      p_create_only: true, p_files: [{ path, content: original, revision: 0 }] })
    assert.equal(source.error, null)
    await page.reload()
    console.log('Editor check: load pinned runtime, type and render actual diff.')
    const input = page.getByRole('textbox', { name: 'Source editor', exact: true })
    await expect(input).toBeVisible({ timeout: 20_000 })
    await input.focus()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.insertText(modified)
    await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Changes', exact: true }).click()
    await expect(page.locator('.monaco-diff-editor')).toBeVisible()
    await expect.poll(() => page.locator('.monaco-diff-editor .line-insert').count()).toBeGreaterThan(0)
    await scan(page, 'real Monaco diff')
    await page.getByRole('button', { name: 'Editor', exact: true }).click()
    await expect(input).toBeVisible()
    await page.getByRole('button', { name: 'Revert changes', exact: true }).click()
    await expect(page.getByText('Unsaved changes', { exact: true })).toHaveCount(0)
    await scan(page, 'real Monaco editor')
    assert(assets.has(`${base}${assetPrefix}loader.js`))
    assert(assets.has(`${base}${assetPrefix}editor/editor.main.js`))
    for (const url of assets) assert(url.startsWith(`${base}${assetPrefix}`), 'Editor assets must use only the deployment’s pinned runtime.')
    await expect.poll(() => workers.size).toBeGreaterThan(0)
    for (const url of workers) assert(url.startsWith(`${base}${assetPrefix}`) || url.startsWith(`blob:${base}/`), 'Editor workers must be same-origin.')

    // A stalled script must yield a usable basic editor after 20 seconds, then
    // a late response must not replace the user's active draft or steal focus.
    await page.route(`${base}${assetPrefix}loader.js`, loaderRoute)
    console.log('Editor check: hold loader response and verify 20-second basic-mode fallback.')
    await page.reload({ waitUntil: 'domcontentloaded' })
    const basic = page.getByRole('textbox', { name: 'Source editor (basic mode)', exact: true })
    await expect(basic).toBeVisible({ timeout: 25_000 })
    await basic.fill(modified)
    releaseLoader?.()
    await expect.poll(() => page.evaluate(() => Boolean(window.monaco?.editor))).toBe(true)
    await expect(basic).toHaveValue(modified)
    await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible()
    await scan(page, 'basic editor recovery')
    await page.getByRole('button', { name: 'Revert changes', exact: true }).click()
    await expect(basic).toHaveValue(original)
    const saved = await admin.from('source_files').select('content,revision').eq('project_id', projectId).eq('path', path).single()
    assert.equal(saved.error, null)
    assert.deepEqual(saved.data, { content: original, revision: 1 }, 'Editing/reverting must not mutate saved source.')
    console.log('PASS: actual Monaco editing/diff/workers and basic recovery; saved source unchanged. VM status was simulated, not live.')
  } finally {
    releaseLoader?.()
    await page.unroute(`${base}${assetPrefix}loader.js`, loaderRoute)
    page.off('request', watchRequest); page.off('worker', watchWorker)
    // Remove only this synthetic registration so later browser checks make no
    // real Sandbox calls. Source belongs to a disposable account cleaned up by
    // the caller even when an assertion fails.
    const removed = await admin.from('sandbox_sessions').delete().eq('project_id', projectId).eq('sandbox_id', sandboxId).eq('user_id', account.id)
    assert.equal(removed.error, null)
    await page.reload()
    await page.unroute(`${base}${prefix}**`, vmRoute)
  }
}
