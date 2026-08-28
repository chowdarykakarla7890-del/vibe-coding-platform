# Signed-in workspace and recovery verification

Local checkpoint, 2026-08-28. These changes are not deployed. The dirty worktree also contains an unfinished SaaS migration; this is not approval to promote it as a small production patch.

## Reproduced and repaired

- Browser project creation on `127.0.0.1` failed same-origin validation because NextURL normalizes loopback addresses to `localhost`. A shared origin helper restores only a validated loopback Host on the same port. It does not equate different loopback origins or trust forwarded-host headers. Callback, proxy and sign-out redirects preserve the actual browser origin. Real NextRequest regression tests cover IPv4, IPv6, localhost and forged authorities.
- A new project's empty saved conversation was rejected by AI SDK's generation-input validator. History decoding now explicitly supports empty history and pending/failed/interrupted assistant placeholders, without adding fake parts, dropping attempts, or mutating the saved rows. Nonempty parts still pass the real SDK validator. Empty user/completed messages, duplicate IDs, malformed parts, failed reads and malformed API responses remain errors; no history is cleared.
- After a successful 100% assessment, the activity header still displayed the hardcoded “Not submitted” label. It now derives “Best: N%” from refreshed authoritative activity progress and otherwise says “No scored attempts.” This is an activity-wide best score, not a claim that the current edited source has been assessed. Tests cover refresh without remount, zero scores and activity isolation.

## Browser evidence

### Activity startup follow-up

Activity startup now uses the account-scoped restoration pipeline instead of raw unbounded creation/upload requests. It validates saved source, persists the chosen language before provisioning its runtime, requires exact upload receipts, and only publishes the completed sandbox into the originating visible project. Existing saved source takes precedence over starter code; selecting a different language for a saved project is rejected before provisioning rather than replacing its files.

Startup has a 120-second preparation deadline and an explicit Cancel/Retry path. Cancellation observes late receipts and requests best-effort cleanup; it is not a rollback of already acknowledged writes, and an unknown creation receipt may still finish server-side. The server propagates request cancellation through SDK creation/compiler preparation, attempts bounded shutdown and marks the reservation failed. An unsuccessful shutdown is not proof the VM stopped; its existing expiration still bounds execution. Final project association is not raced against cancellation. Account changes never authorize cleanup using the replacement account.

Project creation/settings writes now capture the originating account before waiting in a queue. Strict Mode's probe mount does not dispatch a create and leave the actual mount permanently initialized. The startup panel contains its language selector (formerly obscured behind the overlay), disables it while preparing, and makes the covered workspace inert. The activity header displays the selected language rather than the catalog default.

Regression tests reproduce the original missing cancellation, invalid upload acknowledgment, cross-project publication, late account writes, and hidden/unlocked language selector. The final suite passes 988 tests with nine opt-in suites skipped, lint, TypeScript, diff checks and the Node 24 production build; the production dependency audit reports no known vulnerabilities. An initial parallel build/test attempt failed with explicit `ENOSPC` errors and one process timeout. Only this repository's validated generated cache was removed; rerunning tests with two workers and building separately passed without weakening test assertions or timeouts.

The rebuilt local browser verifies selecting Java inside the startup panel, immediate progress, a disabled selector during preparation, and Cancel returning to Retry. The cancelled reservation was marked failed and a read-only SDK check confirmed its VM was stopped. Retry then opened `Main.java`; a solution saved through Monaco earned 100% on trusted checks, proving the selected runtime actually executed. After stopping only that fixture VM, the saved solution and best score remained visible. Close dismissed the expiry dialog, the Restore control reopened it, and restoration loaded the one saved Java file into a new sandbox. Submitting the restored source again passed all 24 server-controlled checks. Both grading capture jobs were acknowledged. No browser warnings/errors were captured during this flow. The fixture stopped its VMs, signed out the temporary session and removed its account/projects; an independent hosted query confirmed zero remaining fixture accounts. This is not a deployment or an AI-provider verification.

### Earlier Python workspace checkpoint

The production-built local application on `http://127.0.0.1:3112` was exercised using normal browser navigation, buttons and editor keyboard input, with a disposable real Supabase account and real Vercel sandboxes:

1. Signed-out workspace redirects to sign-in; a legitimate disposable password-grant session opens the authenticated workspace.
2. Automatic Playground creation succeeds after the origin repair. The empty chat loads rather than replacing the application with “Saved conversation could not be opened.”
3. DSA → Two Sum creates its project, starts a sandbox and loads the Python starter in Monaco.
4. A hash-map solution entered in Monaco remains an unsaved draft after switching to Preview and back. Submit is disabled while dirty. Save completes and enables Submit.
5. Submit returns 100%, with 24/24 server-controlled behavioral checks. The submission-history dialog displays the persisted Python attempt. No AI call is needed for this trusted evaluator.
6. Stopping only the fixture's VM outside the application causes the expiry dialog. The editor remains mounted with its saved source visible and read-only; commands are disabled.
7. Close dismisses the dialog, the “Sandbox expired · Restore” control reopens it, and Restore creates a replacement and reports one restored file. The dialog settles rather than trapping the application in loading.
8. Running the restored solution in the terminal returns `[0, 1]` for the example input. Source-capture lifecycle logs acknowledge both grading and terminal capture jobs.
9. Reloading the final build retains the restored source and displays “Best: 100%.” Switching to the empty Playground does not show the activity's source; switching back restores the activity editor and progress. This is idle-project isolation, not background-generation isolation.

Final gates: 969 unit/component/route tests pass, nine opt-in live suites are skipped by default, and lint, TypeScript, the Node 24 production build and `git diff --check` pass. The production dependency audit reports no known vulnerabilities. A test-fixture typing error caught by the final build was corrected and both TypeScript and build rerun successfully. Cleanup confirmed both temporary browser fixture accounts were absent from hosted auth; the final browser reload returned to sign-in. The helper confirmed its disposable VMs were stopped. No customer data, schema, credentials or deployment changed in this checkpoint.

This check covers one Python activity and saved-source restoration. It does **not** prove email delivery, GitHub/Google OAuth, live AI generation, all activities/languages, a running embedded web preview, responsive/axe coverage, all browser-console conditions, or production deployment. Preview was toggled for draft preservation, not claimed as a verified web-server preview. The user's earlier global production exception was not reproduced here and has no newly claimed root cause.

## Local fixture and cleanup

Run the app on port 3112 using the existing local environment, then explicitly start:

```sh
RUN_BROWSER_WORKSPACE_FIXTURE=1 node --env-file=.env.local scripts/browser-workspace-fixture.mjs
```

Open `http://127.0.0.1:3113/` only in a signed-out local test browser. The helper creates one disposable account and authenticates through the real Supabase password grant. It is not included in the Next.js application and adds no auth bypass. It does not inspect existing browser cookies/storage or expose account credentials in HTML, URLs or logs. Its local forms require the expected Host, exact Origin, bounded content type/body and a per-run nonce.

For an isolated build, `TEST_APP_URL=http://127.0.0.1:3124 TEST_BROWSER_PORT=3125` selects different app/helper ports. Only unprivileged HTTP loopback origins without credentials, paths, queries or fragments are accepted; the two ports must differ. Other local ports on the same hostname share browser cookie scope, so still verify that the local test browser is signed out first. The 2026-08-28 sign-out check used this configuration, retained an unsent draft after Cancel and reached `/sign-in` after confirmation without browser console errors. Its fixture account was removed and checked independently; see [sign-out evidence](./authentication-readiness.md#account-scoped-sign-out-2026-08-28).

“Expire test sandboxes” targets only the fixture account's VMs and does not alter saved source. “Finish and remove test resources,” SIGINT, SIGTERM or the 25-minute deadline runs cleanup: stop fixture VMs, invalidate the fixture session and delete the disposable account with its project/history rows. Cleanup failures are reported, not treated as success. Existing accounts, browser storage, source and credentials must not be cleared to run this test.

See [release gates](./saas-release-gates.md) for the remaining production blockers.
