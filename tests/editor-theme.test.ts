import { expect, it, vi } from 'vitest'
import { defineEditorTheme, EDITOR_THEME } from '@/lib/editor/theme'

function luminance(hex: string) {
  const values = hex.match(/[a-f0-9]{2}/gi)!.map(value => parseInt(value, 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722
}

it('retains the dark syntax palette and gives keywords/comments readable contrast on both diff backgrounds', () => {
  const defineTheme = vi.fn()
  defineEditorTheme({ editor: { defineTheme } } as never)
  expect(defineTheme).toHaveBeenCalledWith(EDITOR_THEME, expect.objectContaining({ base: 'vs-dark', inherit: true, rules: [] }))
  const colors = defineTheme.mock.calls[0][1].colors as Record<string, string>
  for (const foreground of ['#569cd6', '#6a9955', '#ce9178', '#d4d4d4']) {
    for (const background of Object.values(colors)) {
      expect((luminance(foreground) + 0.05) / (luminance(background) + 0.05)).toBeGreaterThanOrEqual(4.5)
    }
  }
})
