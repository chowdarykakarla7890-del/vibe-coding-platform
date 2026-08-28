import { afterEach, describe, expect, it, vi } from 'vitest'
import { readLocalPreference, writeLocalPreference } from '@/lib/local-preferences'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('optional browser preferences', () => {
  it('does not touch browser storage during server rendering', () => {
    vi.stubGlobal('window', undefined)
    expect(readLocalPreference('key')).toBeNull()
    expect(writeLocalPreference('key', 'value')).toBe(false)
  })

  it('reads, writes, and removes only the requested preference', () => {
    const storage = { getItem: vi.fn(() => 'value'), setItem: vi.fn(), removeItem: vi.fn() }
    vi.stubGlobal('window', { localStorage: storage })
    expect(readLocalPreference('key')).toBe('value')
    expect(writeLocalPreference('key', 'next')).toBe(true)
    expect(storage.setItem).toHaveBeenCalledWith('key', 'next')
    expect(writeLocalPreference('key', null)).toBe(true)
    expect(storage.removeItem).toHaveBeenCalledWith('key')
  })

  it('does not crash when the localStorage getter is blocked by browser policy', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.stubGlobal('window', { get localStorage() { throw new DOMException('Blocked', 'SecurityError') } })
    expect(readLocalPreference('key')).toBeNull()
    expect(writeLocalPreference('key', 'value')).toBe(false)
    expect(writeLocalPreference('key', null)).toBe(false)
  })

  it('keeps preferences intact when storage is full and can retry later', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const storage = {
      getItem: vi.fn(() => 'old'),
      setItem: vi.fn().mockImplementationOnce(() => { throw new DOMException('Full', 'QuotaExceededError') }),
      removeItem: vi.fn(),
      clear: vi.fn(),
    }
    vi.stubGlobal('window', { localStorage: storage })
    expect(writeLocalPreference('key', 'new')).toBe(false)
    expect(storage.clear).not.toHaveBeenCalled()
    expect(storage.removeItem).not.toHaveBeenCalled()
    expect(readLocalPreference('key')).toBe('old')
    expect(writeLocalPreference('key', 'new')).toBe(true)
  })
})
