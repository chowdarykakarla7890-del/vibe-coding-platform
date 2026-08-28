// UI preferences are best-effort. A disabled/full localStorage must not take
// down the workspace or hide projects successfully loaded from IndexedDB.
let warned = false

function warnUnavailable() {
  if (warned) return
  warned = true
  console.warn('Browser preferences could not be saved or loaded. The workspace remains available; preferences may reset after reload.')
}

export function readLocalPreference(key: string): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(key)
  } catch {
    warnUnavailable()
    return null
  }
}

export function writeLocalPreference(key: string, value: string | null): boolean {
  if (typeof window === 'undefined') return false
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
    return true
  } catch {
    warnUnavailable()
    return false
  }
}
