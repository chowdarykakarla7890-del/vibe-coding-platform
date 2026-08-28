# Disposable browser verification

The database CI job installs pinned Chromium through Playwright and runs `scripts/ci-browser.mjs` against its own production Next.js server and fresh local Supabase stack. Results belong to the exact tested commit in [draft PR #1](https://github.com/chowdarykakarla7890-del/vibe-coding-platform/pull/1); a checked-in test alone is not proof of success. A browser failure fails the required aggregate check.

## Safety and scope

- Refuses execution outside disposable GitHub CI, with private environment files, with hosted/paid service credentials, or against anything except the fixed loopback application/database origins.
- Creates two unique temporary Auth users. Each signs in through the real email form, local Mailpit inbox, one-time verification link, PKCE callback and session cookies. It never injects browser cookies or exports authentication state.
- Keeps server credentials in the Node test runner, not page scripts. Restricts browser HTTP traffic to the local app and Auth service. No AI call or Sandbox VM is created.
- Deletes only the accounts it created and closes its own browser contexts in `finally`; the enclosing CI job removes its disposable database even when checks fail.
- Does not upload traces, screenshots, email contents, session state or raw browser exceptions. Accessibility failures report rule IDs, selectors and numeric/color-only contrast measurements; other errors identify the failing stage. One-time email links must never enter CI logs.

## Covered workflows

Real passwordless sign-in and selected-model resumption; UI project creation, renaming, switching, reload and confirmed deletion; project-specific saved chat; cross-account API/UI isolation; confirmed sign-out without affecting the other account; keyboard and collapsed navigation; a mobile drawer and tutor/workspace controls; horizontal overflow; reduced-motion mode; uncaught browser errors and hydration/update-loop errors.

The suite scans sign-in, desktop workspace, project dialogs, the Practice catalog, mobile navigation/tutor and sign-out using axe's WCAG 2/2.1 A/AA tags, without excluded rules or elements. Automated scans do not prove complete accessibility or visual quality.

## Regressions exposed by the first runs

- [Initial browser run](https://github.com/chowdarykakarla7890-del/vibe-coding-platform/actions/runs/33139006359): real local email/PKCE sign-in and selected-model resumption worked, but desktop contrast failed. The chat status now uses the readable muted-foreground token; terminal help, timestamps and enabled input placeholders use a legible shade on the fixed dark terminal surface.
- [Next run](https://github.com/chowdarykakarla7890-del/vibe-coding-platform/actions/runs/33139394452): desktop passed, but opening the Create project dialog left the fading project menu exposed. A jsdom regression simulates Radix's retained exit-animation content and reproduced the missing hidden/inert state. Closing project menus now become non-interactive and leave the accessibility tree immediately, while dialog focus stays intact.
- [Further run](https://github.com/chowdarykakarla7890-del/vibe-coding-platform/actions/runs/33139700449): creation, database persistence, project-scoped chat/reload, renaming and desktop keyboard navigation passed; the mobile drawer contrast scan failed. Compiled CSS also revealed that state-specific animation selectors outranked `motion-reduce:animate-none`. Shared dialog and popover animations are now scoped to `motion-safe`, and the browser suite asserts computed `animationName` is `none` for reduced-motion project dialogs and navigation.

These checks deliberately stop at the first failed boundary. Each subsequent source change must complete the entire flow again; passing an earlier stage does not imply later sign-out, account isolation or console checks passed. All three cited runs cleaned up their temporary browser accounts and disposable databases.

## Still separate release gates

This is Chromium against a disposable local database, not hosted OAuth, real customer email delivery, cross-browser/device coverage, live AI streaming, actual Sandbox restore/terminal/preview, scheduler deployment or a production smoke test. Saved chat fixtures are seeded deliberately; they do not claim an LLM generated the answers. See [the broader release gates](./saas-release-gates.md).

References: [Next.js Playwright testing](https://nextjs.org/docs/app/guides/testing/playwright), [Playwright accessibility testing](https://playwright.dev/docs/accessibility-testing), [Supabase test isolation](https://supabase.com/docs/guides/local-development/testing/overview), and [Mailpit's local API](https://mailpit.axllent.org/docs/api-v1/).
