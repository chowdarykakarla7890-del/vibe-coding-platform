import type { DiffOnMount } from '@monaco-editor/react'

/** Monaco 0.56 diff layout/options updates can replace construction-only pane
 * labels with an empty ariaLabel. Maintain names via the public editor API,
 * without rewriting its DOM or creating a configuration-update loop.
 */
export const labelDiffEditors: DiffOnMount = (diff, monaco) => {
  const inputs = [
    [diff.getOriginalEditor(), 'Saved version'],
    [diff.getModifiedEditor(), 'Your draft'],
  ] as const
  const subscriptions = inputs.map(([editor, name]) => {
    const ensureLabel = () => {
      if (!editor.getOption(monaco.editor.EditorOption.ariaLabel).startsWith(name)) {
        editor.updateOptions({ ariaLabel: name })
      }
    }
    const subscription = editor.onDidChangeConfiguration(ensureLabel)
    ensureLabel()
    return subscription
  })
  diff.onDidDispose(() => subscriptions.forEach(subscription => subscription.dispose()))
}
