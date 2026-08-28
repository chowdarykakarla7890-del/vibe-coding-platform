// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import GlobalError from '@/app/global-error'
import WorkspaceError from '@/app/(platform)/error'

const { push } = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

let documentRoot: Root | undefined
let frame: HTMLIFrameElement | undefined
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => {
  cleanup()
  if (documentRoot) {
    act(() => documentRoot!.unmount())
    documentRoot = undefined
    frame?.remove()
    frame = undefined
  }
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe.each(['workspace', 'global'] as const)('%s error recovery', (scope) => {
  function mount(error: unknown, retry = vi.fn()) {
    // Next passes the actual thrown value, even when it is not an Error.
    const props = { error, retry }
    if (scope === 'global') {
      // Give the full-document fallback its own document instead of sharing
      // delegated root listeners with the workspace component test container.
      frame = document.createElement('iframe')
      document.body.appendChild(frame)
      const page = frame.contentDocument!
      documentRoot = createRoot(page)
      act(() => documentRoot!.render(<GlobalError {...props} />))
      return { retry, view: within(page.documentElement) }
    }
    render(<WorkspaceError {...props} />)
    return { retry, view: screen }
  }

  it.each([null, undefined, 'private upstream response'])('keeps retry usable for a non-Error throw (%s)', error => {
    const { retry, view } = mount(error)
    expect(view.getByText(/Do not clear site data/)).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Try again' }))
    expect(retry).toHaveBeenCalledOnce()
    expect(console.error).toHaveBeenCalledWith(expect.any(String), { errorName: 'UnknownError' })
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('private upstream response')
  })

  it('keeps recovery usable when error metadata itself throws', () => {
    const error = new Error('private file content')
    Object.defineProperty(error, 'name', { get: () => { throw new Error('metadata unavailable') } })
    const { retry, view } = mount(error)
    fireEvent.click(view.getByRole('button', { name: 'Try again' }))
    expect(retry).toHaveBeenCalledOnce()
    expect(console.error).toHaveBeenCalledWith(expect.any(String), { errorName: 'UnknownError' })
  })

  it('reports only diagnostic metadata and does not retry automatically', () => {
    const error = Object.assign(new TypeError('private prompt or file content'), { digest: '123456789' })
    const { retry, view } = mount(error)
    expect(retry).not.toHaveBeenCalled()
    expect(console.error).toHaveBeenCalledWith(expect.any(String), { errorName: 'TypeError', digest: '123456789' })
    expect(view.queryByText('private prompt or file content')).toBeNull()
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('private prompt or file content')
  })
})
