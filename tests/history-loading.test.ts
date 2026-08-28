import { afterEach, describe, expect, it, vi } from 'vitest'
import { listProgress, listProjects } from '@/lib/learning/db'
import { HISTORY_LOAD_TIMEOUT_MS, loadWorkspaceHistory } from '@/lib/learning/load-history'

vi.mock('@/lib/learning/db', () => ({ listProjects: vi.fn(), listProgress: vi.fn() }))

afterEach(() => { vi.resetAllMocks(); vi.useRealTimers() })

describe('workspace history loading', () => {
  it('returns both reads without writing or creating a project', async () => {
    vi.mocked(listProjects).mockResolvedValue([])
    vi.mocked(listProgress).mockResolvedValue([])
    await expect(loadWorkspaceHistory(new AbortController().signal)).resolves.toEqual([[], []])
    expect(listProjects).toHaveBeenCalledOnce()
    expect(listProgress).toHaveBeenCalledOnce()
  })

  it('does not turn storage failure into an empty workspace and allows retry', async () => {
    vi.mocked(listProjects).mockRejectedValueOnce(new DOMException('Blocked', 'SecurityError')).mockResolvedValueOnce([])
    vi.mocked(listProgress).mockResolvedValue([])
    await expect(loadWorkspaceHistory(new AbortController().signal)).rejects.toThrow('Blocked')
    await expect(loadWorkspaceHistory(new AbortController().signal)).resolves.toEqual([[], []])
  })

  it('settles a blocked database read after ten seconds and clears its timer', async () => {
    vi.useFakeTimers()
    vi.mocked(listProjects).mockReturnValue(new Promise(() => {}))
    vi.mocked(listProgress).mockResolvedValue([])
    const result = expect(loadWorkspaceHistory(new AbortController().signal)).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(HISTORY_LOAD_TIMEOUT_MS)
    await result
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels on unmount and ignores a late database result', async () => {
    vi.useFakeTimers()
    let finish!: (projects: []) => void
    vi.mocked(listProjects).mockReturnValue(new Promise((resolve) => { finish = resolve }))
    vi.mocked(listProgress).mockResolvedValue([])
    const controller = new AbortController()
    const result = expect(loadWorkspaceHistory(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    finish([])
    await result
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not start reads for an already unmounted workspace', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(loadWorkspaceHistory(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(listProjects).not.toHaveBeenCalled()
    expect(listProgress).not.toHaveBeenCalled()
  })

  it('aborts both underlying requests on timeout, and gives a retry a fresh signal', async () => {
    vi.useFakeTimers()
    vi.mocked(listProjects).mockReturnValueOnce(new Promise(() => {})).mockResolvedValueOnce([])
    vi.mocked(listProgress).mockReturnValueOnce(new Promise(() => {})).mockResolvedValueOnce([])
    const result = expect(loadWorkspaceHistory(new AbortController().signal)).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(HISTORY_LOAD_TIMEOUT_MS)
    await result
    const projectSignal = vi.mocked(listProjects).mock.calls[0][0]
    const progressSignal = vi.mocked(listProgress).mock.calls[0][0]
    expect(projectSignal?.aborted).toBe(true)
    expect(progressSignal?.aborted).toBe(true)
    await expect(loadWorkspaceHistory(new AbortController().signal)).resolves.toEqual([[], []])
    expect(vi.mocked(listProjects).mock.calls[1][0]).not.toBe(projectSignal)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts the other read when either history request fails', async () => {
    vi.mocked(listProjects).mockRejectedValue(new Error('Project storage unavailable'))
    vi.mocked(listProgress).mockReturnValue(new Promise(() => {}))
    await expect(loadWorkspaceHistory(new AbortController().signal)).rejects.toThrow('Project storage unavailable')
    expect(vi.mocked(listProgress).mock.calls[0][0]?.aborted).toBe(true)
  })
})
