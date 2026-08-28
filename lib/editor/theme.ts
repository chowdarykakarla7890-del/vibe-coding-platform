import type { BeforeMount } from '@monaco-editor/react'

export const EDITOR_THEME = 'codetutor-dark'

// Keep the existing dark syntax palette. Darker diff backgrounds preserve text
// contrast instead of washing out blue keywords with Monaco's default overlay.
export const defineEditorTheme: BeforeMount = monaco => {
  monaco.editor.defineTheme(EDITOR_THEME, {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'diffEditor.insertedLineBackground': '#142019',
      'diffEditor.insertedTextBackground': '#1b271d',
      'diffEditor.removedLineBackground': '#241818',
      'diffEditor.removedTextBackground': '#2c1d1d',
    },
  })
}
