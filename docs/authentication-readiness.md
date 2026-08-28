# Authentication readiness

Updated 2026-08-28. Local implementation and service inspection are not production deployment approval.

## Verified service state

The hosted `codetutor` Supabase project (`lyxbhjebtkvaihmjyjtk`) reports `ACTIVE_HEALTHY`. Its public Auth settings return HTTP 200: email and GitHub enabled, Google disabled, registrations enabled, and email auto-confirmation disabled. No Preview branch exists. Provider flags do not verify OAuth credentials, consent configuration, redirect allowlists, SMTP deliverability, or an actual sign-in.

### Hosted security and redirect configuration (2026-08-28)

The existing organization is on Pro. Following the Supabase password-security guidance, **Prevent use of leaked passwords** is now enabled and survives a dashboard reload. A real disposable user's attempt to change its random password to a known leaked password is rejected with `weak_password` and reason `pwned`. The security advisor now returns zero warnings/errors and nine informational, intentionally service-only RLS notices. No billing plan, provider credentials, password-length requirement, or customer password was changed.

The hosted default Site URL is **`https://codetutor-app-red.vercel.app`**, not CodeTutor Studio. Its existing five redirect entries (that app's callback/device paths, the `codetutor://` callback, and localhost/127.0.0.1 port 3000 patterns) were preserved. Do not replace this default or remove those entries until the owner confirms whether that application still shares this project.

Added only `/auth/callback` and `/auth/callback?next=**` for each of these origins:

- `https://codetutor-studio.vercel.app`
- `http://localhost:3010` and `http://127.0.0.1:3010`
- `http://localhost:3112` and `http://127.0.0.1:3112`

The hosted list now has 15 entries. The new patterns keep the host and callback path fixed; they are not a wildcard for arbitrary production paths or other Vercel tenants. The local `supabase/config.toml` mirrors CodeTutor Studio's callback entries only; it must not be pushed over the hosted configuration, which also belongs to the other app.

Run the explicit service check with:

```sh
node --env-file=.env.local scripts/verify-auth-security.mjs
```

It creates one random, confirmed `example.invalid` account, tests leaked-password rejection, and generates—but never opens or emails—magic links to check actual redirect matching. The final run passes all 15 checks: password rejection, ten callback variants (with/without encoded `next`), and rejection of an external origin, lookalike origin, unrelated production path and callback suffix. All three probe runs signed out and deleted their own disposable account. The first probes exposed missing query matches and configuration propagation; only the final fresh recheck passed every case. No customer account, source, VM, AI request, schema, credentials or app deployment was changed. These checks do not prove email delivery, OAuth consent, PKCE exchange, or a successful deployed workspace session.

The local TOML parses with ten unique callback entries. Lint, TypeScript, whitespace checks and 100 focused authentication/deployment tests pass. The final security-advisor recheck again reports zero warnings/errors and the same nine intentional informational notices. No production build or full test-suite run is claimed for this service-configuration checkpoint.

The read-only preflight uses only the public key and prints only these flags:

```sh
node --env-file=.env.local scripts/check-auth-service.mjs
```

It currently exits 1 with `GOOGLE_DISABLED`, deliberately. `pnpm check:auth` runs the same check using already-loaded environment variables. The check sends no email, starts no OAuth flow, creates no users, and changes no service settings. A successful result only proves that all three promised methods and registrations are enabled.

## Application behavior

- Sign-in discovers enabled email/GitHub/Google methods with a ten-second whole-read deadline. Invalid settings and service failures offer an explicit Retry without a polling loop. Disabled methods are hidden, not advertised as working.
- Each form permits one active sign-in attempt. Email and provider confirmation waits settle after twenty seconds; stale results after unmount or timeout cannot update the form or redirect it. SDK email delivery may still complete after the wait ends: timeout is not cancellation or rollback, and no automatic resend occurs.
- A confirmed email request offers explicit resend after a one-minute UI cooldown. Supabase's own rate limits remain authoritative. Users must open the newest link in the initiating browser. The installed SDK's default PKCE callback uses its latest pending verifier; cross-browser and simultaneous-flow behavior are not claimed as verified.
- OAuth uses `skipBrowserRedirect` and validates the configured Auth origin, authorization path, provider and exact callback before navigating. No provider credentials or tokens are stored by this UI.
- Callback failures and signed-in visits to sign-in retain safe activity/model destinations. External, auth-route and oversized destinations fall back to Playground. Provider errors, authorization codes and credentials are not copied into error messages or logs.
- Existing device data is not deleted or silently imported by authentication.

## Server session outage handling

Workspace/API access and the return redirect from sign-in use the live Auth user check. Verified claims remain an optimistic proxy check for protected pages; they do not authorize project data. This avoids a cached-claims redirect sending a denied user back to a workspace that immediately redirects to sign-in. Supabase documents the distinction in [getUser](https://supabase.com/docs/reference/javascript/auth-getuser) and [getClaims](https://supabase.com/docs/reference/javascript/auth-getclaims). This is not a claim that every already-issued JWT becomes invalid immediately on sign-out or user deletion.

- Missing sessions, invalid JWTs and explicit rejected-session codes require sign-in. Transport errors, quotas, unknown/malformed responses and service outages fail closed as `503 AUTH_UNAVAILABLE`, with `Retry-After: 5`, a request ID and `private, no-store`. They are not mislabeled as `401 AUTH_REQUIRED`.
- Complete server authentication waits—including cookie/client initialization, refresh, response headers/body and user/claims verification—are bounded to ten seconds. Caller cancellation becomes `408 AUTH_INTERRUPTED`. Late completions cannot authorize work, dispatch further SDK requests or write cookies after cancellation/failure.
- Successful clients remain usable for subsequent owned-data queries; their deadline is cleared, while the originating request cancellation remains attached. Acknowledged refresh cookies are preserved on redirects, including multiple cookie updates.
- Code exchange and sign-out have the same deadline and cookie guards. Their exact routes bypass the proxy's old-session check, but retain their own authority/CSRF validation. GET does not sign out. Callback failure retains a safe destination without copying codes or provider errors into URLs/logs.
- Proxy GET failures return a static 503 recovery page with an explicit same-page Retry link; non-GET failures use the structured envelope rather than replaying a mutation through a redirect. A live-user outage discovered in the platform layout renders a recovery view without workspace children. That layout fallback can have HTTP 200; only the proxy/API failure paths guarantee 503.
- Timeouts bound confirmation, not server-side rollback. A refresh, exchange or sign-out already accepted by Supabase may complete. No automatic retry, token revocation claim or site-data deletion is used.

## Setup still required

1. Configure a Google **Web application** OAuth client in Google Auth Platform with the intended audience, consent branding and minimum identity scopes. Set its authorized redirect URI to the Supabase provider callback, `https://lyxbhjebtkvaihmjyjtk.supabase.co/auth/v1/callback`, not the app callback. Enter its client ID and secret in Supabase's Google provider settings and enable the provider. Keep the secret out of chat, browser code and `NEXT_PUBLIC_` variables. See [Supabase Google setup](https://supabase.com/docs/guides/auth/social-login/auth-google#project-setup).
2. Verify the Google and GitHub provider credentials/consent with a real customer-like test account. Configure and test the app's `/auth/callback` redirects for the exact development/production origins, including the safe `next` query used by the app. Verify denial, expired/reused codes and callback error recovery. Do not broadly allow other tenants' Vercel domains.
3. Configure a production email sender and verify domain authentication, real delivery, expired/resend behavior and same-browser PKCE completion. An enabled email flag or API 200 is not a delivery test. See [production SMTP guidance](https://supabase.com/docs/guides/auth/auth-smtp).
4. Provision a separately authorized Preview database only after organization/cost confirmation, then repeat provider, redirect, migration and two-user isolation checks there. Do not connect Preview to the production database.
5. Confirm whether `codetutor-app-red.vercel.app` still shares this Supabase project before changing the default Site URL. Leaked-password protection is now enabled and verified; the passwordless UI does not mean password authentication is disabled at the service. The nine `rls_enabled_no_policy` informational notices describe intentionally service-only, deny-all tables; do not grant access to silence them.
6. Deploy the verified sign-out recovery below and repeat it with real customer email/OAuth sessions in the isolated Preview environment. Native browser keyboard/screen-reader checks, induced browser service outages and concurrent multi-tab token refresh remain separate release checks.

The hosted changes in the latest checkpoint are limited to leaked-password protection and the ten additional redirect entries above. OAuth provider credentials/enabled flags, SMTP, database policies, credentials and app deployment remain unchanged. See the broader [release gates](./saas-release-gates.md) and [environment isolation requirements](./deployment-environments.md).

## Verification evidence

### Account-scoped sign-out (2026-08-28)

Six failing route cases reproduced missing identity checks and missing JSON confirmation. The workspace now opens a confirmation dialog instead of navigating a native form into an API error page. Dirty Monaco files block submission until saved or copied. The modal prevents interacting with the covered workspace during the bounded request; Cancel/Close/Escape remain available before submission and after a failure. Failures retain the workspace and offer an explicit Retry. The complete browser receipt, including response body, is bounded to 20 seconds; unmount/account changes abort waiting and late success cannot redirect a newer account. No automatic retry or saved-data deletion is performed.

`POST /auth/sign-out` accepts `Accept: application/json` with `X-CodeTutor-Account` and returns `{ signedOut: true }`, request ID and `private, no-store`. The live verified user must match that account; a mismatch returns 409 without invoking sign-out. Missing/invalid JSON identity returns 400 before Auth work. A missing session is an idempotent retry. The native same-origin form still returns 303, GET remains 405, and cross-origin POST remains 403. Auth work retains the ten-second deadline and `{ scope: 'local' }`. This does not promise immediate invalidation of previously issued access JWTs or rollback of a timed-out Auth operation; see [Supabase sign-out scopes](https://supabase.com/docs/guides/auth/signout).

Verification:

- 34 new route/client/component tests pass; the full local suite passes 1,945 tests with 17 opt-in tests skipped. TypeScript, lint and whitespace checks pass. The production dependency audit reports no known vulnerabilities. Security advisors report zero warnings/errors and the same nine intentional service-only informational notices.
- An isolated Node 24 / Next.js 16.3.1 production **webpack** build passes. It emitted disk-space warnings for optional build-cache writes; no source files or existing preview build directories were removed or overwritten. This is not a new Turbopack build claim.
- The real two-user local HTTP → hosted Supabase suite passes the JSON/native flows, stale-account denial, malformed identity, CSRF, GET refusal, acknowledged cookie removal and an already-signed-out retry, plus its existing ownership/history/source/assessment/quota/cascade checks. Both temporary accounts were signed out and removed; only this runner's synthetic never-started cleanup jobs were settled.
- The isolated built app on port 3124 was exercised with the local disposable password-grant fixture: it started signed out, opened an authenticated Playground, showed the confirmation dialog, retained an unsent composer draft after Cancel, and returned to `/sign-in` after explicit confirmation. No browser warning/error was captured. The fixture account/project was removed, and a separate hosted query confirmed that account no longer exists. No email, OAuth consent, paid AI/VM, customer data, schema or production deployment was involved. Monaco dirty guards and service-outage behavior have component tests, not newly claimed live-VM/outage browser verification.

The local browser fixture supports explicit unprivileged `127.0.0.1` app/helper ports via `TEST_APP_URL` and `TEST_BROWSER_PORT`, retaining strict Host/Origin/nonce checks. This permits verification without replacing an existing local preview. The temporary build/server are removed after verification; original source and running previews remain intact.

### Earlier server-outage checkpoint

- Server-outage follow-up: nine initial failures reproduced incorrect 401s, unhandled proxy outages, cached-claims redirect disagreement, auth-route interception and an unbounded user lookup. The repaired paths pass all 108 focused server-auth/security checks, including cancellation, late cookies, multiple refresh-cookie updates, malformed responses, anonymous users, exact route bypass, safe status envelopes and private layout recovery.
- The complete current suite passes 1,899 tests (17 live opt-ins skipped), with lint, TypeScript, Node 24 production build, exact toolchain, whitespace checks and production dependency audit. A simultaneous test/build attempt initially failed with `ENOSPC`; only the project's 466 MB generated Turbopack cache was removed, then tests and build were rerun sequentially and passed. Source, credentials and device data were not removed.
- The rebuilt local app passes the real two-user hosted HTTP/database suite, now also checking sign-out GET refusal, cross-origin POST rejection, anonymous POST routing, authenticated 303 and acknowledged expired session cookies. Both fixture users were removed and only their synthetic cleanup jobs settled. The browser sign-in page preserves the requested model destination and loads enabled methods without console errors. Actual provider delivery and browser-rendered outage injection were not tested; simulated outage coverage is in the route/component tests.
- The public preflight still reports email/GitHub enabled and Google disabled; the security advisor still has the password-protection warning and nine intentional service-only RLS notices. No provider settings, schema, production deployment, paid VM or AI request changed in this follow-up.

### Earlier sign-in form checkpoint

- Four regressions failed before repair: unbounded email confirmation, missing enabled Google control, callback-failure destination loss and signed-in destination loss.
- All 109 focused auth/UI/security checks pass, including disabled/malformed settings, stalled headers/body, unmount, late replies, explicit retry/resend, duplicate clicks, safe OAuth destinations and non-string/oversized `next` inputs.
- The full suite passes 1,844 tests (17 opt-in live tests skipped); lint, TypeScript, exact toolchain, Node 24 production build, whitespace checks and production dependency audit pass.
- The rebuilt local sign-in page displays email/GitHub, hides disabled Google and shows callback recovery guidance without browser warnings/errors. No email or OAuth consent flow was started; native keyboard, screen-reader and real provider-delivery checks remain open.
- The real two-user local-HTTP → hosted-Supabase integration suite passes, including cookie-authenticated destination resumption, callback denial recovery, ownership, RLS, durable history/source, quotas and cascades. Its new redirect assertion initially expected an absolute header; it now checks the resolved same-origin destination because Next.js can return a valid relative Location. Both runs removed their two disposable users and settled only their own never-started synthetic cleanup records. No paid VM or AI call was made.
