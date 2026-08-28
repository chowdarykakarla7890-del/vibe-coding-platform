import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadChat } from '@/lib/learning/db'
import { CHAT_LOAD_TIMEOUT_MS, loadProjectChat } from '@/lib/learning/load-chat'

vi.mock('@/lib/learning/db', () => ({ loadChat: vi.fn() }))
afterEach(() => { vi.resetAllMocks(); vi.useRealTimers() })

describe('saved conversation loading', () => {
  it('keeps read failures distinct from empty history and allows retry', async () => {
    vi.mocked(loadChat).mockRejectedValueOnce(new Error('Storage unavailable')).mockResolvedValueOnce([])
    await expect(loadProjectChat('project', new AbortController().signal)).rejects.toThrow('Storage unavailable')
    await expect(loadProjectChat('project', new AbortController().signal)).resolves.toEqual([])
  })
  it('settles a stalled storage read and clears the deadline timer', async () => {
    vi.useFakeTimers()
    vi.mocked(loadChat).mockReturnValue(new Promise(() => {}))
    const result = expect(loadProjectChat('project', new AbortController().signal)).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(CHAT_LOAD_TIMEOUT_MS)
    await result
    expect(vi.getTimerCount()).toBe(0)
  })
  it('cancels promptly when a project changes, ignoring late storage data', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    let finish!: (value: []) => void
    vi.mocked(loadChat).mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const result = expect(loadProjectChat('project', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    await Promise.resolve()
    controller.abort()
    finish([])
    await result
    expect(vi.getTimerCount()).toBe(0)
  })
})
