import assert from 'node:assert/strict'
import { checkHtmlSecurity } from './check-html-security.mjs'

/** Dedicated context: expected attack-probe violations must not weaken the
 * normal application's zero-warning/error gate. No paid endpoints are called. */
export async function checkBrowserSecurity({ browser, base, expect }) {
  const context = await browser.newContext({ baseURL: base, bypassCSP: false })
  const page = await context.newPage()
  const errors = []
  let phase = 'document navigation'
  let probing = false, outsideRequests = 0
  page.on('pageerror', () => errors.push('pageerror'))
  page.on('console', message => {
    if (!['error', 'warning'].includes(message.type())) return
    if (!probing || !/Content Security Policy/i.test(message.text())) errors.push(message.type())
  })
  await context.route(/^https?:/, route => {
    const origin = new URL(route.request().url()).origin
    if (origin === base || origin === 'http://127.0.0.1:54321') return route.continue()
    outsideRequests++; return route.abort()
  })
  await page.route(`${base}/__codetutor_csp_child.js`, route => route.fulfill({ contentType: 'text/javascript', body: 'window.__cspChildExecuted = true;' }))
  const frameOrigin = 'https://codetutor-csp-fixture.vercel.run'
  await page.route(`${frameOrigin}/`, route => route.fulfill({ contentType: 'text/html', body: `<script>let parentReadable=false;try{parent.document.body;parentReadable=true}catch{}parent.postMessage({cspFrameLoaded:true,parentReadable},${JSON.stringify(base)})</script>` }))
  try {
    const response = await page.goto('/sign-in')
    phase = 'document nonce validation'
    checkHtmlSecurity(await response.headerValue('content-security-policy'), await response.text())
    phase = 'sign-in hydration'
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Continue with email', exact: true })).toBeEnabled()
    assert.equal(errors.length, 0, 'Normal sign-in must initialize without CSP failures.')
    phase = 'isolated script and frame probes'
    probing = true
    await page.evaluate(({ frameOrigin }) => {
      window.__cspViolations = []
      document.addEventListener('securitypolicyviolation', event => window.__cspViolations.push(event.effectiveDirective))
      window.addEventListener('message', event => { if (event.origin === frameOrigin && event.data?.cspFrameLoaded) window.__cspFrame = event.data })
      const blocked = document.createElement('script')
      blocked.textContent = 'window.__cspInlineExecuted = true;'
      document.body.appendChild(blocked)
      const button = document.createElement('button')
      button.setAttribute('onclick', 'window.__cspHandlerExecuted = true;')
      document.body.appendChild(button); button.click(); button.remove()
      const trusted = document.createElement('script')
      trusted.nonce = document.querySelector('script[nonce]').nonce
      trusted.textContent = `window.__cspTrustedExecuted=true;
        try { new Function('window.__cspEvalExecuted=true')() } catch { window.__cspEvalBlocked=true }
        fetch('https://notallowed.invalid/csp-probe').catch(()=>{window.__cspFetchBlocked=true});
        const child=document.createElement('script');child.src='/__codetutor_csp_child.js';document.body.appendChild(child);`
      document.body.appendChild(trusted)
      const allowed = document.createElement('iframe')
      allowed.setAttribute('sandbox', 'allow-scripts allow-same-origin')
      allowed.src = `${frameOrigin}/`; document.body.appendChild(allowed)
      const denied = document.createElement('iframe')
      denied.src = 'https://notallowed.invalid/frame'; document.body.appendChild(denied)
    }, { frameOrigin })
    await expect.poll(() => page.evaluate(() => Boolean(window.__cspChildExecuted && window.__cspEvalBlocked && window.__cspFetchBlocked && window.__cspFrame?.cspFrameLoaded))).toBe(true)
    phase = 'probe result validation'
    const result = await page.evaluate(() => ({ inline: Boolean(window.__cspInlineExecuted), handler: Boolean(window.__cspHandlerExecuted),
      eval: Boolean(window.__cspEvalExecuted), trusted: window.__cspTrustedExecuted, parentReadable: window.__cspFrame.parentReadable,
      violations: window.__cspViolations }))
    assert.deepEqual({ ...result, violations: undefined }, { inline: false, handler: false, eval: false, trusted: true, parentReadable: false, violations: undefined })
    for (const directive of ['script-src-elem', 'script-src-attr', 'connect-src', 'frame-src']) assert(result.violations.includes(directive))
    assert.equal(outsideRequests, 0, 'Forbidden connections/frames must be blocked before network dispatch.')
    assert.equal(errors.length, 0, 'Only deliberate CSP violations are expected in this isolated probe.')
    console.log('PASS: production nonce bootstrap, trusted dynamic scripts, blocked inline/handler/eval/connect/frame probes and isolated allowed preview frame.')
  } catch {
    // Boolean probe results and known directive names only. Never print an
    // assertion payload, document HTML, nonce, URL, cookies or console text.
    const evidence = await page.evaluate(() => ({
      trusted: Boolean(window.__cspTrustedExecuted), child: Boolean(window.__cspChildExecuted),
      evalBlocked: Boolean(window.__cspEvalBlocked), fetchBlocked: Boolean(window.__cspFetchBlocked),
      frameLoaded: Boolean(window.__cspFrame?.cspFrameLoaded),
      violations: (window.__cspViolations ?? []).filter(value => ['script-src-elem', 'script-src-attr', 'script-src', 'connect-src', 'frame-src'].includes(value)),
    })).catch(() => ({ pageUnavailable: true }))
    console.error(JSON.stringify({ securityProbe: phase, evidence, errors, outsideRequests }))
    throw new Error('Isolated browser security probe failed.')
  } finally { await context.close() }
}
