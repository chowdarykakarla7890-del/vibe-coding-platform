import { afterEach, expect, it, vi } from 'vitest'
import { chatRowSchema, decodeChatRows } from '@/lib/chat/serialization'
import { loadChat, setUserStorageScope } from '@/lib/learning/db'

afterEach(() => { setUserStorageScope(undefined); vi.unstubAllGlobals() })

it('opens an explicitly empty saved conversation without asking the SDK to validate a generation request', async () => {
  await expect(decodeChatRows([])).resolves.toEqual([])
})

it('loads the actual empty-history API shape through the real decoder', async () => {
  setUserStorageScope(crypto.randomUUID())
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ messages: [], nextCursor: null })))
  await expect(loadChat(crypto.randomUUID())).resolves.toEqual([])
})

it('still rejects malformed nonempty saved parts rather than clearing history', async () => {
  const row = chatRowSchema.parse({ id: 'fixture-message', role: 'assistant', parts: [{ type: 'unknown-part' }], status: 'complete', model_id: null, ordinal: 1, updated_at: new Date().toISOString() })
  await expect(decodeChatRows([row])).rejects.toThrow('Saved conversation data is invalid')
})

it('preserves pending assistant shells and normal saved text without mutating rows', async () => {
  const rows = [
    chatRowSchema.parse({ id: 'user-message', role: 'user', parts: [{ type: 'text', text: 'Saved question' }], status: 'complete', model_id: null, ordinal: 1, updated_at: new Date().toISOString() }),
    chatRowSchema.parse({ id: 'assistant-message', role: 'assistant', parts: [], status: 'pending', model_id: null, ordinal: 2, updated_at: new Date().toISOString() }),
  ]
  const original = structuredClone(rows)
  await expect(decodeChatRows(rows)).resolves.toMatchObject([
    { id: 'user-message', parts: [{ type: 'text', text: 'Saved question' }] },
    { id: 'assistant-message', parts: [], metadata: { persistenceStatus: 'pending' } },
  ])
  expect(rows).toEqual(original)
})

it.each(['pending', 'failed', 'interrupted'] as const)('preserves an otherwise empty %s assistant turn for Stop/Retry', async status => {
  const row = chatRowSchema.parse({ id: 'assistant-message', role: 'assistant', parts: [], status, model_id: null, ordinal: 1, updated_at: new Date().toISOString() })
  await expect(decodeChatRows([row])).resolves.toMatchObject([{ id: row.id, parts: [], metadata: { persistenceStatus: status } }])
})

it('does not legitimize empty user/completed messages or duplicate identities', async () => {
  const row = chatRowSchema.parse({ id: 'fixture-message', role: 'user', parts: [], status: 'complete', model_id: null, ordinal: 1, updated_at: new Date().toISOString() })
  await expect(decodeChatRows([row])).rejects.toThrow('invalid')
  await expect(decodeChatRows([{ ...row, role: 'assistant' }])).rejects.toThrow('invalid')
  const populated = { ...row, parts: [{ type: 'text', text: 'Saved' }] }
  await expect(decodeChatRows([populated, populated])).rejects.toThrow('invalid')
})

it('does not reinterpret failed or malformed reads as an empty conversation', async () => {
  setUserStorageScope(crypto.randomUUID())
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(Response.json({ error: { message: 'Storage unavailable' } }, { status: 502 }))
    .mockResolvedValueOnce(Response.json({ nextCursor: null })))
  await expect(loadChat(crypto.randomUUID())).rejects.toThrow('Storage unavailable')
  await expect(loadChat(crypto.randomUUID())).rejects.toThrow('invalid response')
})

it('preserves the server generation identity for a fenced Stop without adding it to legacy messages', async () => {
  const requestId = crypto.randomUUID()
  const row = chatRowSchema.parse({ id: 'assistant', role: 'assistant', parts: [], status: 'pending', model_id: null,
    ordinal: 1, updated_at: new Date().toISOString(), request_id: requestId })
  expect((await decodeChatRows([row]))[0].metadata?.requestId).toBe(requestId)
  expect((await decodeChatRows([{ ...row, request_id: null }]))[0].metadata?.requestId).toBeUndefined()
})
