import { describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'test-user' } }, error: null }) } }),
  createAdminSupabaseClient: vi.fn(() => { throw new Error('Invalid requests must not reach the database') }),
}))
import { GET as readFile, POST as createNode, PUT as updateFile } from '../app/api/sandboxes/[sandboxId]/files/route'
import { POST as runTerminalCommand } from '../app/api/sandboxes/[sandboxId]/terminal/route'
import { POST as createSandbox } from '../app/api/sandboxes/route'
import { PUT as restoreSnapshot } from '../app/api/sandboxes/[sandboxId]/snapshot/route'
import { NextRequest } from 'next/server'
import { readJsonBody } from '../lib/request-body'

const context = {
  params: Promise.resolve({ sandboxId: 'sbx_test' }),
}

function malformedRequest() {
  return new Request('http://localhost/api/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost' },
    body: '{',
  })
}

describe('request boundaries', () => {
  it('bounds JSON bodies before parsing them', async () => {
    await expect(
      readJsonBody(
        new Request('http://localhost/api/test', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ value: '🙂'.repeat(10) }),
        }),
        16
      )
    ).resolves.toMatchObject({ ok: false, reason: 'too-large' })

    await expect(
      readJsonBody(
        new Request('http://localhost/api/test', {
          method: 'POST',
          body: '{}',
        }),
        16
      )
    ).resolves.toMatchObject({
      ok: false,
      reason: 'unsupported-content-type',
    })
  })

  it('rejects malformed file mutations before contacting Sandbox', async () => {
    const updateResponse = await updateFile(malformedRequest() as never, context)
    const createResponse = await createNode(malformedRequest() as never, context)

    expect(updateResponse.status).toBe(400)
    await expect(updateResponse.json()).resolves.toMatchObject({
      error: { code: 'INVALID_FILE_UPDATE' },
    })
    expect(createResponse.status).toBe(400)
    await expect(createResponse.json()).resolves.toMatchObject({
      error: { code: 'INVALID_FILE_PATH' },
    })
  })

  it('rejects traversal reads and multibyte files over 256 KB', async () => {
    const traversalResponse = await readFile(
      new NextRequest('http://localhost/api/test?path=../secret'),
      context
    )
    const oversizedResponse = await restoreSnapshot(
      new Request('http://localhost/api/test', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ files: [{ path: 'src/unicode.txt', content: '🙂'.repeat(70_000) }] }),
      }),
      context
    )

    expect(traversalResponse.status).toBe(400)
    expect(oversizedResponse.status).toBe(400)
    await expect(oversizedResponse.json()).resolves.toMatchObject({
      error: { code: 'INVALID_SNAPSHOT' },
    })
  })

  it('rejects a malformed terminal command before contacting Sandbox', async () => {
    const response = await runTerminalCommand(malformedRequest() as never, context)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'INVALID_REQUEST' },
    })
  })

  it('rejects malformed sandbox and snapshot bodies before external work', async () => {
    const sandboxResponse = await createSandbox(malformedRequest())
    const snapshotResponse = await restoreSnapshot(malformedRequest(), context)

    expect(sandboxResponse.status).toBe(400)
    await expect(sandboxResponse.json()).resolves.toMatchObject({
      error: { code: 'INVALID_REQUEST' },
    })
    expect(snapshotResponse.status).toBe(400)
    await expect(snapshotResponse.json()).resolves.toMatchObject({
      error: { code: 'INVALID_SNAPSHOT' },
    })
  })
})
