// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatProvider, useSharedChatContext } from '@/lib/chat-context'
import { loadChat } from '@/lib/learning/db'
import { setCloudAccount } from '@/lib/learning/cloud-request'

const learning = vi.hoisted(() => ({ activeProjectId: 'project-a' as string | undefined, isReady: true, projects: [{ id: 'project-a' }, { id: 'project-b' }], updateProject: vi.fn() }))
vi.mock('@/lib/learning/learning-provider', () => ({ useLearning: () => learning }))
vi.mock('@/lib/learning/db', () => ({ loadChat: vi.fn(), stopProjectChat: vi.fn() }))

function Conversation() {
  const { chatState } = useSharedChatContext()
  return <div data-testid="conversation">{chatState.messages.map((message) => message.parts.map((part) => part.type === 'text' ? part.text : '').join('')).join('\n')}</div>
}

beforeEach(() => { setCloudAccount('550e8400-e29b-41d4-a716-446655440000') })
afterEach(() => { cleanup(); setCloudAccount(undefined); vi.resetAllMocks(); learning.activeProjectId = 'project-a' })

describe('saved conversation recovery', () => {
  it('mounts the empty-account workspace without requesting a nonexistent conversation', async () => {
    learning.activeProjectId = undefined
    render(<ChatProvider><Conversation /></ChatProvider>)
    expect((await screen.findByTestId('conversation')).textContent).toBe('')
    expect(loadChat).not.toHaveBeenCalled()
  })

  it('does not mount an empty writable conversation after a read failure; Retry loads the saved messages', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.mocked(loadChat).mockRejectedValueOnce(new Error('Storage unavailable')).mockResolvedValueOnce([{ id: 'saved', role: 'assistant', parts: [{ type: 'text', text: 'Saved explanation' }] }])
    render(<ChatProvider><Conversation /></ChatProvider>)
    await screen.findByRole('button', { name: 'Retry conversation' })
    expect(screen.queryByTestId('conversation')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry conversation' }))
    expect((await screen.findByTestId('conversation')).textContent).toBe('Saved explanation')
  })

  it('ignores a late read from a previous project', async () => {
    let finish!: (value: Awaited<ReturnType<typeof loadChat>>) => void
    vi.mocked(loadChat).mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
      .mockResolvedValueOnce([{ id: 'b', role: 'assistant', parts: [{ type: 'text', text: 'Project B' }] }])
    const view = render(<ChatProvider><Conversation /></ChatProvider>)
    await act(async () => {})
    learning.activeProjectId = 'project-b'
    view.rerender(<ChatProvider><Conversation /></ChatProvider>)
    expect((await screen.findByTestId('conversation')).textContent).toBe('Project B')
    await act(async () => finish([{ id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'Project A' }] }]))
    expect(screen.getByTestId('conversation').textContent).toBe('Project B')
  })
})
