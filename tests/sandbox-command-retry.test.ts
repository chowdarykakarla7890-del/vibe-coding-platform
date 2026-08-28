import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

const sdk = dirname(createRequire(import.meta.url).resolve('@vercel/sandbox'))
const url = 'https://vercel.com/api/v2/sandboxes/sessions/test/cmd?teamId=test'

describe.each(['js', 'cjs'])('actual Sandbox %s command retry policy', (extension) => {
  async function retry(fetch: typeof globalThis.fetch) {
    const sdkModule = await import(pathToFileURL(join(sdk, 'api-client', `with-retry.${extension}`)).href)
    return sdkModule.withRetry(fetch)
  }
  it.each([429, 500, 503])('does not replay command creation after HTTP %i', async (status) => {
    const fetch = vi.fn(async () => new Response('', { status }))
    const response = await (await retry(fetch))(url, { method: 'POST', retry: { retries: 5, minTimeout: 1 } })
    expect(response.status).toBe(status)
    expect(fetch).toHaveBeenCalledOnce()
  })
  it('does not replay a command after an uncertain network failure', async () => {
    const fetch = vi.fn(async () => { throw new TypeError('Connection lost') })
    await expect((await retry(fetch))(url, { method: 'POST' })).rejects.toThrow('Connection lost')
    expect(fetch).toHaveBeenCalledOnce()
  })
  it('retains bounded retries for safe reads', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(new Response('ok'))
    expect((await (await retry(fetch))(url, { method: 'GET', retry: { retries: 1, minTimeout: 1 } })).status).toBe(200)
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
