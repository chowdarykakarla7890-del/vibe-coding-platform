// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SubmissionHistory } from '@/components/learning/submission-history'
import { setCloudAccount } from '@/lib/learning/cloud-request'
import { gradingSummary } from './fixtures/grading-evidence'

const account = '11111111-1111-4111-8111-111111111111', projectId = '22222222-2222-4222-8222-222222222222', id = '33333333-3333-4333-8333-333333333333'
const summary = { id, createdAt: '2026-08-27T10:00:00Z', state: 'complete', failureCode: null, language: 'JavaScript', modelId: 'test/model', score: 85, passed: true, sourceCurrentAtAssessment: false }
const detail = { ...summary, title: 'Example activity', sourceDigest: 'a'.repeat(64), files: [{ path: 'main.js', revision: 1 }, { path: 'helper.js', revision: 2 }], feedback: ['Clear implementation'] }
const file = { path: 'main.js', content: 'retained original source', revision: 1 }
const fetcher = vi.fn()
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
beforeEach(() => {
  setCloudAccount(account); vi.stubGlobal('fetch', fetcher)
  fetcher.mockImplementation(async (url: string) => response(url.includes('?file=') ? file : url.endsWith(id) ? detail : { submissions: [summary], nextCursor: null }))
})
afterEach(() => { cleanup(); setCloudAccount(undefined); vi.useRealTimers(); vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllGlobals() })
function mount() { const view = render(<SubmissionHistory projectId={projectId} />); fireEvent.click(screen.getByRole('button', { name: 'Submissions' })); return view }
async function openDetail() { fireEvent.click(await screen.findByRole('button', { name: /85%/ })); await screen.findByText('Clear implementation') }

describe('retained submission history', () => {
  it.each(['list', 'detail', 'file'] as const)('settles stalled %s headers and rejects late results after retry', async (scope) => {
    await checkStalledRead(scope, 'headers')
  })
  it.each(['list', 'detail', 'file'] as const)('settles a stalled %s body and rejects late results after retry', async (scope) => {
    await checkStalledRead(scope, 'body')
  })
  it.each([
    [gradingSummary, '23/24 checks passed.'],
    [{ ...gradingSummary, status: 'prepared', passedCount: null, outcomes: [], completedAt: null }, '24 checks retained; no complete grading result was recorded.'],
    [{ ...gradingSummary, passedCount: 0, compileFailure: 'execution-error', outcomes: [] }, 'Compilation: Execution failed. No checks ran.'],
  ])('shows safe retained grading outcomes: %j', async (evidence, label) => {
    fetcher.mockImplementation(async (url: string) => response(url.includes('?file=') ? file : url.endsWith(id) ? { ...detail, gradingSummary: evidence, aiAssessed: false } : { submissions: [summary], nextCursor: null }))
    mount(); await openDetail()
    const section = screen.getByRole('region', { name: 'Retained grading evidence' })
    expect(section.textContent).toContain(label)
    expect(section.textContent).toContain('hidden test data is not exposed')
    if (evidence.outcomes.length) {
      const toggle = screen.getByText('Check-by-check outcomes')
      expect(toggle.tagName).toBe('SUMMARY')
      expect(section.querySelectorAll('li')).toHaveLength(24)
      expect(section.textContent).toContain('Check 24: Incorrect result')
    } else expect(screen.queryByText('Check-by-check outcomes')).toBeNull()
  })

  it('rejects a response containing private test data instead of displaying it', async () => {
    fetcher.mockImplementation(async (url: string) => response(url.endsWith(id) ? { ...detail, gradingSummary: { ...gradingSummary, inputs: ['PRIVATE_SENTINEL'] } } : { submissions: [summary], nextCursor: null }))
    mount(); fireEvent.click(await screen.findByRole('button', { name: /85%/ }))
    expect((await screen.findByRole('alert')).textContent).toContain('invalid response')
    expect(screen.queryByText('PRIVATE_SENTINEL')).toBeNull()
  })
  it.each([[true, 'AI assessed'], [false, 'Trusted checks'], [null, 'Assessment']] as const)('labels retained evidence correctly when aiAssessed is %s', async (aiAssessed, label) => {
    fetcher.mockImplementation(async (url: string) => response(url.includes('?file=') ? file : url.endsWith(id) ? { ...detail, aiAssessed } : { submissions: [{ ...summary, aiAssessed }], nextCursor: null }))
    mount()
    expect(await screen.findByRole('button', { name: new RegExp(`85% · ${label}`) })).toBeTruthy()
    await openDetail()
    expect(screen.getByText(`85% · ${label}`)).toBeTruthy()
  })
  it('loads only when opened and shows exact source without saving it into the workspace', async () => {
    render(<SubmissionHistory projectId={projectId} />)
    expect(fetcher).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Submissions' })); await openDetail()
    expect((await screen.findByLabelText('Submitted source: main.js')).textContent).toBe(file.content)
    expect(screen.getByText(/Newer source existed/)).toBeTruthy()
    expect(screen.getByLabelText('Submitted source: main.js').tabIndex).toBe(0)
    expect(fetcher).toHaveBeenCalledTimes(3)
    for (const [, init] of fetcher.mock.calls) {
      expect(init.method).toBeUndefined()
      expect(new Headers(init.headers).get('X-CodeTutor-Account')).toBe(account)
    }
  })
  it('aborts file reads when the selected file changes', async () => {
    let complete!: (response: Response) => void
    fetcher.mockImplementation(async (url: string) => url.includes('?file=0') ? new Promise((resolve) => { complete = resolve }) : response(url.includes('?file=1') ? { ...file, path: 'helper.js', content: 'helper source' } : url.endsWith(id) ? detail : { submissions: [summary], nextCursor: null }))
    mount(); await openDetail()
    await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.includes('?file=0'))).toBe(true))
    const oldSignal = fetcher.mock.calls.find(([url]) => url.includes('?file=0'))![1].signal
    fireEvent.change(screen.getByLabelText('Submitted file'), { target: { value: '1' } })
    expect(oldSignal.aborted).toBe(true)
    expect((await screen.findByLabelText('Submitted source: helper.js')).textContent).toBe('helper source')
    await act(async () => complete(response(file)))
    expect(screen.queryByText(file.content)).toBeNull()
  })
  it('aborts requests when history closes', async () => {
    let complete!: (response: Response) => void
    fetcher.mockImplementation(() => new Promise((resolve) => { complete = resolve }))
    mount(); await waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    const signal = fetcher.mock.calls[0][1].signal
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(signal.aborted).toBe(true)
    await act(async () => complete(response({ submissions: [summary], nextCursor: null })))
    expect(screen.queryByRole('button', { name: /85%/ })).toBeNull()
  })
  it('does not display a late result after account switching', async () => {
    let complete!: (response: Response) => void
    fetcher.mockImplementation(() => new Promise((resolve) => { complete = resolve }))
    mount(); await waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    act(() => setCloudAccount('44444444-4444-4444-8444-444444444444'))
    await act(async () => complete(response({ submissions: [summary], nextCursor: null })))
    expect(screen.queryByRole('button', { name: /85%/ })).toBeNull()
  })
  it('offers explicit refresh after failure without a retry loop', async () => {
    fetcher.mockResolvedValueOnce(response({ error: { message: 'History temporarily unavailable' } }, 502))
    mount(); expect((await screen.findByRole('alert')).textContent).toContain('temporarily unavailable')
    expect(fetcher).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh submissions' }))
    expect(await screen.findByRole('button', { name: /85%/ })).toBeTruthy()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('shows an interrupted attempt as no score, not a failed learner grade', async () => {
    fetcher.mockResolvedValue(response({ submissions: [{ ...summary, state: 'interrupted', score: null, passed: null }], nextCursor: null }))
    mount(); expect(await screen.findByRole('button', { name: /Interrupted — no score/ })).toBeTruthy()
  })
})

async function checkStalledRead(scope: 'list' | 'detail' | 'file', phase: 'headers' | 'body') {
  vi.useFakeTimers()
  // Native AbortSignal.timeout uses real timers; advance it with this test's
  // clock too, so the regression proves that an aborted transport still hangs.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms)
    return controller.signal
  })
  let release!: (value: unknown) => void
  let stalledSignal!: AbortSignal
  let stalled = false
  const payload = (url: string) => url.includes('?file=') ? file : url.endsWith(id) ? detail : { submissions: [summary], nextCursor: null }
  fetcher.mockImplementation(async (url: string, init: RequestInit) => {
    const target = scope === 'file' ? url.includes('?file=') : scope === 'detail' ? url.endsWith(id) : url.endsWith('/submissions')
    if (!target || stalled) return response(payload(url))
    stalled = true
    stalledSignal = init.signal as AbortSignal
    const waiting = new Promise(resolve => { release = resolve })
    return phase === 'headers' ? waiting : { ok: true, json: () => waiting }
  })
  mount()
  await act(async () => {})
  if (scope !== 'list') {
    fireEvent.click(screen.getByRole('button', { name: /85%/ }))
    await act(async () => {})
  }
  expect(stalled).toBe(true)
  const beforeRetry = fetcher.mock.calls.length
  await act(async () => { await vi.advanceTimersByTimeAsync(20_001) })
  expect(stalledSignal.aborted).toBe(true)
  expect(screen.getByRole('alert').textContent).toMatch(/timed out/i)
  expect(fetcher).toHaveBeenCalledTimes(beforeRetry)
  fireEvent.click(screen.getByRole('button', { name: scope === 'file' ? 'Retry submitted file' : scope === 'detail' ? 'Retry submission' : 'Refresh submissions' }))
  await act(async () => {})
  expect(screen.queryByRole('alert')).toBeNull()
  expect(fetcher.mock.calls.length).toBeGreaterThan(beforeRetry)
  const stale = scope === 'list' ? { submissions: [{ ...summary, score: 12 }], nextCursor: null }
    : scope === 'detail' ? { ...detail, title: 'STALE_RESULT' } : { ...file, content: 'STALE_RESULT' }
  await act(async () => release(phase === 'headers' ? response(stale) : stale))
  expect(screen.queryByText(/STALE_RESULT|12%/)).toBeNull()
  if (scope === 'list') expect(screen.getByRole('button', { name: /85%/ })).toBeTruthy()
  else expect(screen.getByLabelText('Submitted source: main.js').textContent).toBe(file.content)
}
