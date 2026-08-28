let cancelPendingFocus: (() => void) | undefined

/** Return focus across the asynchronous unmount/load/remount of a workspace. */
export function requestProjectNavigationFocus(projectId: string) {
  cancelPendingFocus?.()
  const findTrigger = () => document.querySelector<HTMLButtonElement>('[data-project-switcher-id]')
  const originalTrigger = findTrigger()
  const originalFocus = document.activeElement
  let stopped = false

  function cancel() {
    if (stopped) return
    stopped = true
    observer.disconnect()
    clearTimeout(initialCheck)
    clearTimeout(deadline)
    document.removeEventListener('pointerdown', cancel, true)
    document.removeEventListener('keydown', cancel, true)
    if (cancelPendingFocus === cancel) cancelPendingFocus = undefined
  }

  function check() {
    if (stopped) return
    const trigger = findTrigger()
    if (!trigger) return // Chat history is still loading.
    if (trigger.dataset.projectSwitcherId !== projectId) {
      // A different navigation/account has replaced the originating workspace.
      if (trigger !== originalTrigger) cancel()
      return
    }
    const focused = document.activeElement
    if (focused === document.body || focused === trigger) {
      cancel()
      trigger.focus()
    } else if (focused !== originalFocus && focused !== originalTrigger) {
      cancel() // Never steal focus from another newly focused control.
    }
  }

  const observer = new MutationObserver(check)
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-project-switcher-id'] })
  // User interaction abandons the handoff, even while history is loading.
  document.addEventListener('pointerdown', cancel, true)
  document.addEventListener('keydown', cancel, true)
  const initialCheck = setTimeout(check, 0)
  const deadline = setTimeout(cancel, 30_000)
  cancelPendingFocus = cancel
  return cancel
}
