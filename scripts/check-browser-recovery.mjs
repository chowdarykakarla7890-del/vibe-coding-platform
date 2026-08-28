import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'

async function downloadedBytes(download) {
  const stream = await download.createReadStream()
  assert(stream, 'The browser must produce the requested download.')
  const chunks = []
  let size = 0
  const timeout = setTimeout(() => stream.destroy(new Error('Fixture download timed out.')), 10_000)
  try {
    for await (const chunk of stream) {
      size += chunk.length
      assert(size <= 1024 * 1024, 'This small recovery fixture must remain bounded.')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  } finally { clearTimeout(timeout); stream.destroy() }
}

/** Disposable signed-in browser only. Lifecycle is simulated; source reads,
 * downloads, staged uploads, publication and history use actual owned APIs/DB.
 * No VM/AI route may run. No download, source or auth payload is logged. */
export async function checkBrowserRecovery({ account, projectId, admin, base, expect, scan, phase }) {
  const { page } = account
  const switcher = () => page.locator('button[data-project-switcher-id]')
  const title = await switcher().innerText()
  const sandboxId = `test-only-${randomUUID()}`
  const prefix = `/api/sandboxes/${sandboxId}`
  const content = 'Saved recovery fixture — తెలుగు 🚀\nSecond line\n'
  const importedIds = []
  let completed = false
  const vmRoute = route => {
    const request = route.request(), url = new URL(request.url())
    if (url.pathname === prefix && request.method() === 'GET') return route.fulfill({ json: { status: 'stopped' } })
    if (url.pathname === `${prefix}/files` && request.method() === 'GET') return route.fallback()
    throw new Error('Recovery browser checks must not execute a paid sandbox operation.')
  }
  const rejectPaid = () => { throw new Error('Import/export must not dispatch AI generation or sandbox creation.') }
  await page.route(`${base}${prefix}**`, vmRoute)
  await page.route(`${base}/api/sandboxes`, rejectPaid)
  await page.route(`${base}/api/chat`, rejectPaid)
  async function menuAction(name) {
    await switcher().click()
    await page.getByRole('button', { name, exact: true }).click()
  }
  async function closeDialog(dialog) {
    await dialog.locator('[data-slot="dialog-footer"]').getByRole('button', { name: 'Close', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    await expect(switcher()).toBeFocused()
  }
  async function dismissExpiry() {
    const dialog = page.getByRole('dialog', { name: 'Sandbox expired', exact: true })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Not now', exact: true }).click()
    await expect(dialog).not.toBeVisible()
  }
  async function savedFiles(id) {
    const result = await admin.from('source_files').select('path,content,revision').eq('project_id', id).eq('user_id', account.id).eq('deleted', false).order('path')
    assert.equal(result.error, null)
    return result.data
  }
  async function assertImported(id, expected) {
    assert.match(id, /^[a-f0-9-]{36}$/)
    assert.notEqual(id, projectId)
    importedIds.push(id)
    const result = await admin.from('projects').select('mode,status,activity_id,sandbox_sessions(sandbox_id)').eq('id', id).eq('user_id', account.id).single()
    assert.equal(result.error, null)
    assert.deepEqual(result.data, { mode: 'playground', status: 'active', activity_id: null, sandbox_sessions: [] })
    assert.deepEqual((await savedFiles(id)).map(({ path, content }) => ({ path, content })), expected.map(({ path, content }) => ({ path, content })))
    const messages = await admin.from('messages').select('id', { count: 'exact', head: true }).eq('project_id', id).eq('user_id', account.id)
    assert.equal(messages.error, null); assert.equal(messages.count, 0, 'Imported history must never become active tool/chat messages.')
  }
  try {
    phase('expired saved-source recovery and read-only editor')
    const registration = await admin.from('sandbox_sessions').insert({ user_id: account.id, project_id: projectId,
      sandbox_id: sandboxId, status: 'expired', expires_at: new Date(Date.now() - 60_000).toISOString() })
    assert.equal(registration.error, null)
    const saved = await admin.rpc('save_source_revision_batch', { p_user_id: account.id, p_project_id: projectId, p_create_only: true,
      p_files: [{ path: 'recovery.txt', content, revision: 0 }] })
    assert.equal(saved.error, null)
    const original = await savedFiles(projectId)
    await page.reload()
    const expired = page.getByRole('dialog', { name: 'Sandbox expired', exact: true })
    await expect(expired).toBeVisible()
    await scan(page, 'expired sandbox recovery dialog')
    await dismissExpiry()
    await page.getByRole('button', { name: 'File recovery.txt', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Source editor', exact: true })).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.monaco.editor.getModels().some(model => model.getValue().includes('Saved recovery fixture')))).toBe(true)
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    await scan(page, 'expired saved-source editor')

    phase('browser source and full-history archive downloads')
    const sourceEvent = page.waitForEvent('download')
    await menuAction('Source export')
    const sourceDownload = await sourceEvent
    assert.match(sourceDownload.suggestedFilename(), /\.codetutor\.json$/)
    const sourceBytes = await downloadedBytes(sourceDownload)
    const source = JSON.parse(sourceBytes.toString('utf8'))
    assert.equal(source.version, 1); assert.equal(source.project.id, projectId)
    assert.equal(source.project.sandboxId, undefined); assert.equal(source.project.previewUrl, undefined)
    assert.deepEqual(source.files.map(({ path, content }) => ({ path, content })), original.map(({ path, content }) => ({ path, content })))
    await page.keyboard.press('Escape')
    await menuAction('Full project archive')
    const archiveDialog = page.getByRole('dialog', { name: 'Export full project archive', exact: true })
    await scan(page, 'full archive export dialog')
    const archiveEvent = page.waitForEvent('download')
    await archiveDialog.getByRole('button', { name: 'Download archive', exact: true }).click()
    const archiveDownload = await archiveEvent
    assert.match(archiveDownload.suggestedFilename(), /\.codetutor-archive\.ndjson$/)
    const archiveBytes = await downloadedBytes(archiveDownload)
    const lines = archiveBytes.toString('utf8').trim().split('\n').map(line => JSON.parse(line))
    const [manifest, ...rest] = lines, end = rest.pop()
    assert.equal(manifest.format, 'codetutor-project-archive'); assert.equal(manifest.version, 3)
    assert.equal(manifest.projectId, projectId); assert.equal(manifest.recordCount, rest.length)
    assert.equal(end.complete, true); assert.equal(end.id, manifest.id)
    for (const [index, envelope] of rest.entries()) {
      assert.equal(envelope.index, index + 1)
      assert.equal(envelope.sha256, createHash('sha256').update(envelope.record).digest('hex'))
    }
    assert.equal(rest.reduce((sum, envelope) => sum + Buffer.byteLength(envelope.record), 0), manifest.payloadBytes)
    assert(rest.some(envelope => JSON.parse(envelope.record).kind === 'message'))
    await expect(archiveDialog.getByText('Archive verified. Download started.', { exact: true })).toBeVisible()
    await closeDialog(archiveDialog)

    phase('source upload validation, published receipt reload and explicit opening')
    await menuAction('Import source')
    let sourceDialog = page.getByRole('dialog', { name: 'Import saved source', exact: true })
    const sourceInput = sourceDialog.getByLabel('Source project export', { exact: true })
    await expect(sourceInput).toBeEnabled()
    await sourceInput.setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{invalid') })
    await sourceDialog.getByRole('button', { name: 'Import source', exact: true }).click()
    await expect(sourceDialog.getByRole('alert')).toContainText('valid source-only CodeTutor JSON export')
    await sourceInput.setInputFiles({ name: 'saved.codetutor.json', mimeType: 'application/json', buffer: sourceBytes })
    await scan(page, 'source import review dialog')
    await sourceDialog.getByRole('button', { name: 'Import source', exact: true }).click()
    await expect(sourceDialog.getByRole('button', { name: 'Open imported project', exact: true })).toBeEnabled()
    await closeDialog(sourceDialog)
    await page.reload(); await dismissExpiry()
    await menuAction('Import source')
    sourceDialog = page.getByRole('dialog', { name: 'Import saved source', exact: true })
    await sourceDialog.getByRole('button', { name: 'Open imported project', exact: true }).click()
    await expect(sourceDialog).not.toBeVisible()
    await expect(switcher()).toBeFocused()
    const sourceId = await switcher().getAttribute('data-project-switcher-id')
    await assertImported(sourceId, original)
    assert.equal(new URL(page.url()).searchParams.get('modelId'), 'openai/gpt-5-nano')

    phase('full archive import and read-only unverified history')
    await menuAction('Import archive')
    const importDialog = page.getByRole('dialog', { name: 'Import full project archive', exact: true })
    const archiveInput = importDialog.getByLabel('Full project archive', { exact: true })
    await expect(archiveInput).toBeEnabled()
    await archiveInput.setInputFiles({ name: 'saved.codetutor-archive.ndjson', mimeType: 'application/x-ndjson', buffer: archiveBytes })
    await scan(page, 'archive import review dialog')
    await importDialog.getByRole('button', { name: 'Import archive', exact: true }).click()
    await importDialog.getByRole('button', { name: 'Open imported project', exact: true }).click()
    await expect(importDialog).not.toBeVisible()
    await expect(switcher()).toBeFocused()
    const archiveId = await switcher().getAttribute('data-project-switcher-id')
    await assertImported(archiveId, original)
    assert.notEqual(archiveId, sourceId)
    await menuAction('Imported history')
    const history = page.getByRole('dialog', { name: 'Imported history', exact: true })
    await expect(history.getByRole('status')).toContainText('Showing records')
    await expect(history.getByText(/archived scores do not count toward verified progress/)).toBeVisible()
    await history.locator('summary').filter({ hasText: /^message · / }).first().click()
    await expect(history.locator('pre').filter({ hasText: 'Only project A contains this saved answer.' })).toBeVisible()
    await scan(page, 'imported history viewer')
    await closeDialog(history)
    assert.deepEqual(await savedFiles(projectId), original, 'Export and recovery must not overwrite original source/revisions.')
    const assessment = await admin.from('assessments').select('id', { count: 'exact', head: true }).in('project_id', importedIds).eq('user_id', account.id)
    assert.equal(assessment.error, null); assert.equal(assessment.count, 0)
    completed = true
    console.log('PASS: expired-source viewing, Unicode source/archive downloads, staged source/imported-history recovery, receipt reload, focus and unchanged original files. VM lifecycle simulated; no paid calls.')
  } finally {
    if (completed) phase('recovery fixture cleanup and original project resumption')
    const removed = await admin.from('sandbox_sessions').delete().eq('project_id', projectId).eq('sandbox_id', sandboxId).eq('user_id', account.id)
    assert.equal(removed.error, null)
    // The browser's project list still contains the synthetic registration.
    // Re-read it before selecting that project, while its lifecycle mock is
    // still installed. Otherwise cleanup itself requests a deleted fixture.
    if (completed) {
      await page.reload()
      await expect(switcher()).toBeVisible()
    }
    await page.unroute(`${base}${prefix}**`, vmRoute)
    await page.unroute(`${base}/api/sandboxes`, rejectPaid)
    await page.unroute(`${base}/api/chat`, rejectPaid)
    // The enclosing harness deletes its own temporary accounts and imports.
    // On success restore the original scope expected by later navigation tests.
    if (completed) {
      if (await switcher().getAttribute('data-project-switcher-id') !== projectId) {
        await menuAction(`${title} (playground)`)
      }
      await page.reload()
    }
  }
}
