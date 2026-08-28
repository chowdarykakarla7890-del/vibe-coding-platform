import { expect, it } from 'vitest'
import { checkHtmlSecurity } from '@/scripts/check-html-security.mjs'
import { contentSecurityPolicy, createNonce } from '@/lib/content-security-policy'

it('checks actual HTML bootstrap tags against the enforced response nonce', () => {
  const nonce = createNonce()
  const policy = contentSecurityPolicy(nonce, { origin: 'https://studio.example', development: false })
  const html = `<script nonce="${nonce}" src="/_next/static/chunk.js" async></script><script nonce="${nonce}">window.fixture=true</script>`
  expect(checkHtmlSecurity(policy, html)).toBe(nonce)
  expect(() => checkHtmlSecurity(null, html)).toThrow()
  expect(() => checkHtmlSecurity(policy, '<html><body>no bootstrap</body></html>')).toThrow()
  expect(() => checkHtmlSecurity(policy, html.replace(`nonce="${nonce}"`, ''))).toThrow()
  expect(() => checkHtmlSecurity(policy, html.replace(nonce, createNonce()))).toThrow()
  expect(() => checkHtmlSecurity(policy.replace("'strict-dynamic'", "'unsafe-inline'"), html)).toThrow()
  expect(() => checkHtmlSecurity(policy.replace("'wasm-unsafe-eval'", "'unsafe-eval'"), html)).toThrow()
})
