import { expect, it } from 'vitest'
import { Script } from 'node:vm'
import { securityProbeHtml } from '@/scripts/check-browser-security.mjs'

it('uses parsed HTML for unnonced injection and normal trusted code for eval probes', () => {
  const nonce = 'abcdefghijklmnopqrstuvwx'
  const html = securityProbeHtml(nonce)
  const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
  expect(scripts).toHaveLength(3)
  expect(scripts.map(match => match[1])).toEqual([` nonce="${nonce}"`, '', ` nonce="${nonce}"`])
  expect(scripts[0][2]).toContain("document.addEventListener('securitypolicyviolation'")
  expect(scripts[1][2]).toBe('window.__cspInlineExecuted=true;')
  expect(scripts[2][2]).toContain("new Function('window.__cspEvalExecuted=true')()")
  expect(scripts[2][2]).toContain("child.src='/__codetutor_csp_child.js'")
  expect(html).toContain('onclick="window.__cspHandlerExecuted=true"')
  for (const script of scripts) expect(() => new Script(script[2])).not.toThrow()
})

it.each(['', 'short', 'abcdefghijklmnopqrstuvw"', '</script><script>attack!'])('rejects invalid probe nonces', nonce => {
  expect(() => securityProbeHtml(nonce)).toThrow()
})
