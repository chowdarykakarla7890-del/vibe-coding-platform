import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { POST } from '@/app/api/projects/[projectId]/messages/stop/route'
import { ApiError, requireOwnedProject, requireUser } from '@/lib/server/api'

const fixture = vi.hoisted(() => ({ filters: new Map<string, unknown>(), update: vi.fn(), abortSignal: vi.fn(), from: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/server/api', async original => ({ ...await original<object>(), requireUser: vi.fn(), requireOwnedProject: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createAdminSupabaseClient: () => ({ from: fixture.from }) }))
const generationId = '550e8400-e29b-41d4-a716-446655440000'
const context = { params: Promise.resolve({ projectId: 'project-a' }) }
function request(body: unknown = { messageId: 'assistant', requestId: generationId }, signal?: AbortSignal) {
  return new Request('http://localhost/api/projects/project-a/messages/stop', { method: 'POST', signal,
    headers: { origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify(body) })
}
beforeEach(() => {
  vi.mocked(requireUser).mockResolvedValue({ user: { id: 'account-a' } } as never)
  vi.mocked(requireOwnedProject).mockResolvedValue({ id: 'project-a' } as never)
  const query = { eq: (key: string, value: unknown) => { fixture.filters.set(key, value); return query }, abortSignal: fixture.abortSignal }
  fixture.from.mockReturnValue({ update: fixture.update })
  fixture.update.mockReturnValue(query)
  fixture.abortSignal.mockResolvedValue({ error: null })
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => { fixture.filters.clear(); vi.useRealTimers(); vi.restoreAllMocks(); vi.resetAllMocks() })

it('updates only the owned pending assistant generation, never merely the reusable message ID', async () => {
  const response = await POST(request(), context)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ stopped: true })
  expect(Object.fromEntries(fixture.filters)).toEqual({ project_id: 'project-a', user_id: 'account-a', id: 'assistant',
    request_id: generationId, role: 'assistant', status: 'pending' })
})
it.each([{ messageId: 'assistant' }, { messageId: 'assistant', requestId: 'invalid' }, { messageId: 'assistant', requestId: generationId, userId: 'forged' }])('rejects unfenced or malformed Stop input before a write', async body => {
  expect((await POST(request(body), context)).status).toBe(400)
  expect(fixture.update).not.toHaveBeenCalled()
})
it.each([401, 404])('rejects access with %s before touching the service-role client', async status => {
  if (status === 401) vi.mocked(requireUser).mockRejectedValueOnce(new ApiError(401, 'AUTH_REQUIRED', 'Sign in.'))
  else vi.mocked(requireOwnedProject).mockRejectedValueOnce(new ApiError(404, 'NOT_FOUND', 'Not found.'))
  expect((await POST(request(), context)).status).toBe(status)
  expect(fixture.from).not.toHaveBeenCalled()
})
it('redacts database failure and returns an explicitly unconfirmed outcome', async () => {
  fixture.abortSignal.mockResolvedValueOnce({ error: new Error('Private database payload') })
  const response = await POST(request(), context)
  expect(response.status).toBe(502)
  const body = await response.json()
  expect(body.error.code).toBe('CHAT_STOP_UNCONFIRMED')
  expect(JSON.stringify(body)).not.toContain('Private database')
})
it('bounds a database response that ignores abort without claiming rollback', async () => {
  vi.useFakeTimers()
  fixture.abortSignal.mockImplementationOnce(() => new Promise(() => {}))
  const response = POST(request(), context)
  await vi.advanceTimersByTimeAsync(10_001)
  expect((await response).status).toBe(502)
  expect((fixture.abortSignal.mock.calls[0][0] as AbortSignal).aborted).toBe(true)
})
it('cancels an obsolete Stop receipt instead of acknowledging it to a different session', async () => {
  let finish!: (value: { error: null }) => void
  fixture.abortSignal.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const controller = new AbortController()
  const response = POST(request(undefined, controller.signal), context)
  await vi.waitFor(() => expect(fixture.abortSignal).toHaveBeenCalledOnce())
  controller.abort()
  expect((await response).status).toBe(502)
  finish({ error: null })
})
