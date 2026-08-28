// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CatalogPage } from '@/components/learning/catalog-page'
import { setCloudAccount } from '@/lib/learning/cloud-request'
import { PRACTICE_ACTIVITIES } from '@/lib/learning/catalog'
import { ACTIVITY_RECEIPT_TIMEOUT_MS } from '@/lib/learning/activity-generation'

const mocks = vi.hoisted(() => ({ push: vi.fn(), error: vi.fn(), list: vi.fn(), learning: { progress: [], activeProjectId: 'project-a' } }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }))
vi.mock('@/lib/learning/learning-provider', () => ({ useLearning: () => mocks.learning }))
vi.mock('@/lib/learning/db', () => ({ listGeneratedActivities: (...args: unknown[]) => mocks.list(...args) }))
vi.mock('sonner', () => ({ toast: { error: mocks.error } }))
const accountA = '11111111-1111-4111-8111-111111111111'
const accountB = '22222222-2222-4222-8222-222222222222'
const activity = { ...PRACTICE_ACTIVITIES[0], id: 'generated-practice-test', source: 'generated' }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
beforeEach(() => {
  setCloudAccount(accountA)
  mocks.learning.activeProjectId = 'project-a'
  mocks.list.mockResolvedValue([])
})
afterEach(() => { cleanup(); setCloudAccount(undefined); vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })
async function open() {
  const view = render(<CatalogPage activities={[]} mode="practice" />)
  fireEvent.click(screen.getByRole('button', { name: 'Custom activity' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Learning goal' }), { target: { value: 'Understand loops' } })
  return view
}

it('Cancel aborts a pending request instead of only hiding the dialog', async () => {
  const pending = deferred<Response>()
  const fetch = vi.fn().mockReturnValue(pending.promise)
  vi.stubGlobal('fetch', fetch)
  await open()
  fireEvent.click(screen.getByRole('button', { name: 'Generate activity' }))
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce())
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true)
  await act(async () => { pending.resolve(Response.json({ activity })) })
  expect(mocks.push).not.toHaveBeenCalled()
})

it('an account change during a delayed response body cannot open the old activity', async () => {
  const pending = deferred<unknown>()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => pending.promise }))
  await open()
  fireEvent.click(screen.getByRole('button', { name: 'Generate activity' }))
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce())
  await act(async () => { setCloudAccount(accountB); pending.resolve({ activity }) })
  expect(mocks.push).not.toHaveBeenCalled()
  expect(screen.queryByRole('alert')).toBeNull()
})

it('validates and opens a saved generated activity with an account-scoped request', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ activity }))
  vi.stubGlobal('fetch', fetch)
  await open()
  fireEvent.click(screen.getByRole('button', { name: 'Generate activity' }))
  await waitFor(() => expect(mocks.push).toHaveBeenCalledWith('/practice/generated-practice-test'))
  expect(fetch).toHaveBeenCalledOnce()
  expect(fetch.mock.calls[0][1].headers.get('X-CodeTutor-Account')).toBe(accountA)
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ mode: 'practice', goal: 'Understand loops', language: 'TypeScript', difficulty: 'intermediate' })
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('deduplicates rapid form submissions', async () => {
  const fetch = vi.fn().mockReturnValue(new Promise(() => {}))
  vi.stubGlobal('fetch', fetch)
  await open()
  const form = screen.getByRole('textbox', { name: 'Learning goal' }).closest('form')!
  fireEvent.submit(form)
  fireEvent.submit(form)
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce())
  expect(screen.getByRole('button', { name: 'Generating…' }).hasAttribute('disabled')).toBe(true)
})

it.each(['headers', 'body'])('bounds stalled response %s without automatically retrying the paid request', async stage => {
  vi.useFakeTimers()
  const pending = deferred<unknown>()
  const fetch = vi.fn().mockReturnValue(stage === 'headers' ? pending.promise : Promise.resolve({ ok: true, json: () => pending.promise }))
  vi.stubGlobal('fetch', fetch)
  await open()
  fireEvent.click(screen.getByRole('button', { name: 'Generate activity' }))
  await act(async () => { await vi.advanceTimersByTimeAsync(ACTIVITY_RECEIPT_TIMEOUT_MS + 1) })
  expect(fetch).toHaveBeenCalledOnce()
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true)
  expect(screen.getByRole('alert').textContent).toContain('confirmation timed out')
  expect(screen.getByRole('button', { name: 'Generate activity' }).hasAttribute('disabled')).toBe(false)
  expect(screen.getByRole('textbox', { name: 'Learning goal' }).getAttribute('maxlength')).toBe('800')
  await act(async () => { pending.resolve(stage === 'headers' ? Response.json({ activity }) : { activity }) })
  expect(mocks.push).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Reload saved activities' }))
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(mocks.list).toHaveBeenCalledTimes(2)
  expect(fetch).toHaveBeenCalledOnce()
})

it.each(['unmount', 'project', 'mode', 'Escape'])('cancels on %s and rejects a late successful result', async reason => {
  const pending = deferred<unknown>()
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: () => pending.promise })
  vi.stubGlobal('fetch', fetch)
  const view = await open()
  fireEvent.click(screen.getByRole('button', { name: 'Generate activity' }))
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce())
  if (reason === 'unmount') view.unmount()
  else if (reason === 'project') { mocks.learning.activeProjectId = 'project-b'; view.rerender(<CatalogPage activities={[]} mode="practice" />) }
  else if (reason === 'mode') view.rerender(<CatalogPage activities={[]} mode="debug" />)
  else fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' })
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true)
  await act(async () => { pending.resolve({ activity }) })
  expect(mocks.push).not.toHaveBeenCalled()
})

it('keeps a new request busy when an older cancelled response arrives', async () => {
  const first = deferred<unknown>(), second = deferred<unknown>()
  const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: () => first.promise }).mockResolvedValueOnce({ ok: true, json: () => second.promise })
  vi.stubGlobal('fetch', fetch)
  await open()
  fireEvent.click(screen.getByRole('button', { name: 'Generate activity' }))
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce())
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  fireEvent.click(screen.getByRole('button', { name: 'Custom activity' }))
  fireEvent.click(screen.getByRole('button', { name: 'Generate activity' }))
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
  await act(async () => { first.resolve({ activity }) })
  expect(mocks.push).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Generating…' }).hasAttribute('disabled')).toBe(true)
  await act(async () => { second.resolve({ activity }) })
  expect(mocks.push).toHaveBeenCalledOnce()
})

it.each([undefined, { activity: {} }, { activity: { ...activity, mode: 'debug' } }, { activity: { ...activity, id: 'practice-not-generated' } }, { activity: { ...activity, source: 'curated' } }])('does not navigate on invalid activity responses', async body => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => body }))
  await open()
  fireEvent.click(screen.getByRole('button', { name: 'Generate activity' }))
  await screen.findByRole('alert')
  expect(mocks.push).not.toHaveBeenCalled()
  expect(screen.getByRole('alert').textContent).toContain('invalid')
})

it('preserves the goal and shows structured quota guidance without auto retry', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ error: { code: 'RATE_LIMITED', message: 'Wait before generating again.', requestId: 'request-1' } }, { status: 429 }))
  vi.stubGlobal('fetch', fetch)
  await open()
  fireEvent.click(screen.getByRole('button', { name: 'Generate activity' }))
  await screen.findByRole('alert')
  expect(screen.getByRole('alert').textContent).toContain('Wait before generating again.')
  expect((screen.getByRole('textbox', { name: 'Learning goal' }) as HTMLTextAreaElement).value).toBe('Understand loops')
  expect(fetch).toHaveBeenCalledOnce()
})
