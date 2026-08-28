import assert from 'node:assert/strict'

/** Inspect only generated markup/headers. Callers must not log HTML or tokens. */
export function checkHtmlSecurity(policy, html) {
  assert.equal(typeof policy, 'string', 'HTML needs an enforced CSP.')
  const directives = Object.fromEntries(policy.split(/;\s*/).filter(Boolean).map(part => {
    const [name, ...values] = part.trim().split(/\s+/); return [name, values]
  }))
  const script = directives['script-src'] ?? []
  const nonces = script.filter(value => /^'nonce-[A-Za-z0-9+/]{24}'$/.test(value))
  assert.equal(nonces.length, 1, 'HTML must have one unpredictable nonce.')
  assert(script.includes("'strict-dynamic'"))
  assert(!script.includes("'unsafe-inline'") && !script.includes("'unsafe-eval'"))
  assert.deepEqual(directives['script-src-attr'], ["'none'"])
  const nonce = nonces[0].slice(7, -1)
  const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map(match => match[0])
  assert(scripts.length > 0, 'The actual rendered app must include bootstrap scripts.')
  for (const tag of scripts) assert.equal(tag.match(/\bnonce="([^"]+)"/)?.[1], nonce, 'Every rendered bootstrap script needs the response nonce.')
  return nonce
}
