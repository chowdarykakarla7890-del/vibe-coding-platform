// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { StrictMode, type ComponentProps } from 'react'
import { PlatformShell } from '@/components/platform/sidebar'
import { useSandboxStore } from '@/app/state'

vi.mock('next/navigation', () => ({ usePathname: () => '/playground' }))
vi.mock('next/link', () => ({ default: ({ onClick, ...props }: ComponentProps<'a'>) => <a {...props} onClick={event => { onClick?.(event); event.preventDefault() }} /> }))
vi.mock('@/lib/local-preferences', () => ({ readLocalPreference: () => null, writeLocalPreference: vi.fn() }))

let desktop: MediaQueryList
beforeEach(() => {
  window.history.replaceState({}, '', '/playground')
  const events = new EventTarget()
  desktop = { matches: false, media: '(min-width: 768px)', onchange: null,
    addEventListener: vi.fn(events.addEventListener.bind(events)), removeEventListener: vi.fn(events.removeEventListener.bind(events)),
    dispatchEvent: events.dispatchEvent.bind(events), addListener: vi.fn(), removeListener: vi.fn(),
  } as MediaQueryList
  vi.stubGlobal('matchMedia', vi.fn(() => desktop))
  useSandboxStore.getState().setDirtyFilePath(undefined)
})
afterEach(() => { cleanup(); useSandboxStore.getState().clearSandbox(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function shell() { return render(<StrictMode><PlatformShell><button>Workspace control</button></PlatformShell></StrictMode>) }

it('unmounts the closed mobile drawer and uses display hiding for the desktop sidebar', () => {
  shell()
  expect(screen.queryByRole('dialog')).toBeNull()
  const aside = screen.getByRole('complementary', { name: 'Desktop navigation' })
  expect(aside.className).toContain('hidden')
  expect(aside.className).toContain('md:flex')
  expect(aside.className).not.toContain('translate')
})

it('opens a labeled modal, confines focus, closes with Escape and returns focus', async () => {
  shell()
  const trigger = screen.getByRole('button', { name: 'Open navigation' })
  trigger.focus()
  fireEvent.click(trigger)
  const dialog = await screen.findByRole('dialog', { name: 'Navigation' })
  await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
  expect(within(dialog).getAllByRole('link')).toHaveLength(8)
  const last = within(dialog).getByRole('link', { name: 'Portfolio' })
  last.focus()
  fireEvent.keyDown(last, { key: 'Tab', code: 'Tab' })
  expect(dialog.contains(document.activeElement)).toBe(true)
  expect(document.activeElement).not.toBe(last)
  fireEvent.keyDown(document.activeElement!, { key: 'Escape', code: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(document.activeElement).toBe(trigger)
})

it('closes an open mobile dialog at the desktop breakpoint and removes its listener', async () => {
  const view = shell()
  fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }))
  await screen.findByRole('dialog')
  act(() => { Object.defineProperty(desktop, 'matches', { value: true }); desktop.dispatchEvent(new Event('change')) })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  view.unmount()
  expect(desktop.removeEventListener).toHaveBeenCalledTimes(2)
})

it.each([{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }])('preserves the draft for modified navigation %j', modifiers => {
  useSandboxStore.getState().setDirtyFilePath('main.ts')
  const confirm = vi.spyOn(window, 'confirm')
  shell()
  fireEvent.click(screen.getByRole('link', { name: 'Practice' }), modifiers)
  expect(confirm).not.toHaveBeenCalled()
  expect(useSandboxStore.getState().dirtyFilePath).toBe('main.ts')
})

it('preserves a draft on the current route and asks before leaving it', () => {
  useSandboxStore.getState().setDirtyFilePath('main.ts')
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  shell()
  fireEvent.click(screen.getByRole('link', { name: 'Playground' }))
  expect(confirm).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('link', { name: 'Practice' }))
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining('main.ts'))
  expect(useSandboxStore.getState().dirtyFilePath).toBe('main.ts')
  confirm.mockReturnValue(true)
  fireEvent.click(screen.getByRole('link', { name: 'Practice' }))
  expect(useSandboxStore.getState().dirtyFilePath).toBeUndefined()
})

it('keeps collapsed icon links named and section controls attached to their hidden content', () => {
  shell()
  const section = screen.getByRole('button', { name: 'Code' })
  const content = document.getElementById(section.getAttribute('aria-controls')!)!
  fireEvent.click(section)
  expect(content.hidden).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }))
  expect(screen.getByRole('link', { name: 'Playground' }).getAttribute('aria-current')).toBe('page')
  expect(content.hidden).toBe(false)
  expect(screen.getByRole('link', { name: 'DSA' })).toBeTruthy()
})
