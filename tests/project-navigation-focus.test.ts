// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { requestProjectNavigationFocus } from '@/lib/client/project-navigation-focus'

let cancel: (() => void) | undefined
const settle = async () => { await Promise.resolve(); await vi.advanceTimersByTimeAsync(0) }
function trigger(id: string) {
  const button = document.createElement('button')
  button.dataset.projectSwitcherId = id
  document.body.append(button)
  return button
}
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { cancel?.(); cancel = undefined; document.body.replaceChildren(); vi.useRealTimers() })

it('waits through asynchronous history loading, not just the next render', async () => {
  const old = trigger('a')
  old.focus()
  cancel = requestProjectNavigationFocus('b')
  old.remove()
  await vi.advanceTimersByTimeAsync(2_000)
  const next = trigger('b')
  await settle()
  expect(document.activeElement).toBe(next)
  expect(vi.getTimerCount()).toBe(0)
})

it.each(['pointerdown', 'keydown'])('abandons the handoff after user %s interaction', async type => {
  const old = trigger('a')
  cancel = requestProjectNavigationFocus('b')
  old.remove()
  document.dispatchEvent(new Event(type, { bubbles: true }))
  trigger('b')
  await settle()
  expect(document.activeElement).toBe(document.body)
  expect(vi.getTimerCount()).toBe(0)
})

it('does not steal focus from another control', async () => {
  const old = trigger('a')
  cancel = requestProjectNavigationFocus('b')
  old.remove()
  const input = document.createElement('input')
  document.body.append(input)
  input.focus()
  trigger('b')
  await settle()
  expect(document.activeElement).toBe(input)
  expect(vi.getTimerCount()).toBe(0)
})

it('cancels when a different project or account workspace mounts', async () => {
  const old = trigger('a')
  cancel = requestProjectNavigationFocus('b')
  old.remove()
  const other = trigger('c')
  await settle()
  other.remove()
  trigger('b')
  await settle()
  expect(document.activeElement).toBe(document.body)
  expect(vi.getTimerCount()).toBe(0)
})

it('expires an abandoned handoff and disconnects its observer', async () => {
  cancel = requestProjectNavigationFocus('b')
  await vi.advanceTimersByTimeAsync(30_000)
  trigger('b')
  await settle()
  expect(document.activeElement).toBe(document.body)
  expect(vi.getTimerCount()).toBe(0)
})

it('supersedes old navigation intent with the latest project', async () => {
  requestProjectNavigationFocus('b')
  cancel = requestProjectNavigationFocus('c')
  const next = trigger('c')
  await settle()
  expect(document.activeElement).toBe(next)
  expect(vi.getTimerCount()).toBe(0)
})
