// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ChatProgress, hasCurrentAssistantOutput } from '@/components/chat/chat-progress'

afterEach(cleanup)
const props = { hasAssistantOutput: true, interrupted: false, modelName: 'Tutor', onRetry: vi.fn(), onStop: vi.fn(), stalled: false, status: 'ready' as const }

it.each(['stopping', 'reconnecting'] as const)('announces %s and prevents repeated actions while awaiting the receipt', operation => {
  const onStop = vi.fn()
  render(<ChatProgress {...props} operation={operation} onStop={onStop} />)
  expect(screen.getByRole('status').textContent).toContain(operation === 'stopping' ? 'Stopping and checking' : 'Reconnecting')
  const stop = screen.getByRole('button', { name: 'Stop tutor response' }) as HTMLButtonElement
  expect(stop.disabled).toBe(true)
  fireEvent.click(stop)
  expect(onStop).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
})

it('shows the uncertain Stop outcome instead of claiming interruption was saved', () => {
  const onRetry = vi.fn()
  const view = render(<ChatProgress {...props} interrupted recoveryError="Could not confirm the saved response. Retry to reconnect." onRetry={onRetry} />)
  expect(screen.queryByText('Generation was stopped before it finished.')).toBeNull()
  expect(screen.getByText(/Could not confirm/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(onRetry).toHaveBeenCalledOnce()
  view.rerender(<ChatProgress {...props} />)
  expect(view.container.textContent).toBe('')
})

it.each(['text', 'reasoning'] as const)('keeps planning feedback for an empty %s part', type => {
  expect(hasCurrentAssistantOutput([{ id: 'assistant', role: 'assistant', parts: [{ type, text: '  ', state: 'streaming' }] }])).toBe(false)
  expect(hasCurrentAssistantOutput([{ id: 'assistant', role: 'assistant', parts: [{ type, text: 'Working', state: 'streaming' }] }])).toBe(true)
})
