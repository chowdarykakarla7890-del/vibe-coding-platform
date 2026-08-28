import { useCallback, useEffect, useState, type SetStateAction } from 'react'
import { readLocalPreference, writeLocalPreference } from './local-preferences'

export function useLocalStorageValue(key: string) {
  const [state, setState] = useState({ key, value: '', initialized: false })

  useEffect(() => {
    const timerId = window.setTimeout(() => {
      const value = readLocalPreference(key) ?? ''
      setState((current) => current.key === key && current.initialized
        ? current
        : { key, value, initialized: true })
    }, 0)
    return () => window.clearTimeout(timerId)
  }, [key])

  useEffect(() => {
    if (state.initialized && state.key === key) {
      writeLocalPreference(key, state.value)
    }
  }, [key, state])

  const setValue = useCallback((update: SetStateAction<string>) => {
    setState((current) => ({
      key,
      value: typeof update === 'function' ? update(current.key === key ? current.value : '') : update,
      initialized: true,
    }))
  }, [key])

  return [state.key === key ? state.value : '', setValue] as const
}
