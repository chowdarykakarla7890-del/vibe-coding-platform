import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { buttonVariants } from '@/components/ui/button'

const css = readFileSync('app/globals.css', 'utf8')
function luminance(color: number[]) {
  const channels = color.map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}
function contrast(a: number[], b: number[]) {
  const light = luminance(a), dark = luminance(b)
  return (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05)
}

it('pairs destructive buttons with the foreground token rather than hardcoded white or a translucent dark override', () => {
  const classes = buttonVariants({ variant: 'destructive' }).split(' ')
  expect(classes).toContain('text-destructive-foreground')
  expect(classes).not.toContain('text-white')
  expect(classes).not.toContain('dark:bg-destructive/60')
  expect(css).toContain('--color-destructive-foreground: var(--destructive-foreground)')
})

it.each([':root', '.dark'])('keeps normal and hovered destructive buttons readable in %s', selector => {
  const declarations = css.slice(css.indexOf(`${selector} {`)).split('}')[0]
  const color = (name: string) => {
    const value = declarations.match(new RegExp(`--${name}: rgb\\(([^)]+)\\)`))?.[1]
    if (!value) throw new Error(`Missing ${selector} ${name} RGB fixture`)
    return value.split(',').map(Number)
  }
  const foreground = color('destructive-foreground'), background = color('destructive')
  expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5)
  for (const surface of ['background', 'card', 'popover']) {
    const behind = color(surface)
    const hovered = background.map((channel, index) => channel * 0.9 + behind[index] * 0.1)
    expect(contrast(foreground, hovered)).toBeGreaterThanOrEqual(4.5)
  }
})
