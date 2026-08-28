# Content Security Policy release gate

The document policy is created in the authentication proxy for each request.
It replaces incoming CSP/nonce headers, forwards the generated nonce through
cookie refresh to Next SSR, and marks HTML responses private/no-store for both
browser and CDN caches. The root layout waits for a request; nonces are not
baked into static HTML. Redirects, auth handlers and auth-outage responses
retain the same policy. Actual public asset paths bypass auth, but arbitrary
image-looking routes and API-prefix lookalikes do not.

Production scripts use a fresh 144-bit nonce and `strict-dynamic`. Inline event
handlers and ordinary JavaScript `eval` are denied. Trusted scripts can load
their dependencies dynamically, including the deployment-pinned Monaco runtime.
Connections are limited to the application and the exact configured Supabase
origin. Development alone permits eval/debugging and HMR WebSockets. HTTP
loopback builds are not upgraded to nonexistent local HTTPS.

Compatibility exceptions are explicit:

- `style-src 'unsafe-inline'` supports Monaco/Radix runtime styles; it does not
  allow inline JavaScript. This is not a nonce-only style policy.
- `wasm-unsafe-eval` permits the highlighter WebAssembly engine, not JavaScript
  string evaluation.
- Images may use HTTPS, data and blob URLs for Markdown and portfolio content.
  External image requests can reveal network metadata; this is not a remote
  image privacy proxy.
- Same-origin/blob workers support Monaco. Worker language diagnostics are
  checked in Chromium, not inferred merely from Worker creation.
- Frames allow Vercel Sandbox origins and only the same-origin BotID challenge
  namespace. Application preview ownership checks remain separate and required.
  The BotID SDK owns its challenge response/iframe policy; it is not overwritten.

The clean HTTP gate checks actual bootstrap-script nonces, cache policy and
nonce changes across requests. A separate disposable browser context tests
blocked inline scripts, handlers, eval, connections and frames, along with
trusted dynamic script loading and an isolated allowed preview frame. Expected
attack-probe violations never weaken the ordinary application's clean-console
gate. Existing real local email/PKCE, project/history and Monaco flows run under
the policy without disabling CSP. Tests neither provision paid resources nor
modify production data.

This checkpoint must pass the clean CI/browser gates before acceptance. Hosted
OAuth delivery, deployed BotID challenges, paid AI streaming, actual hosted
preview/release verification and browser coverage beyond Chromium remain
separate gates. No new policy is claimed to be active on the live deployment.

References: the bundled Next.js Content Security Policy guide and
[current Supabase SSR cookie-refresh guidance](https://supabase.com/docs/guides/auth/server-side/creating-a-client?queryGroups=framework&framework=nextjs).
