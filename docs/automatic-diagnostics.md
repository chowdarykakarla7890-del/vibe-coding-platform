# Automatic command diagnostics

Verified locally on 2026-08-28. These changes are part of the unfinished authenticated SaaS worktree; they are **not deployed**.

## Behavior

The **Automatic diagnostics** setting watches command output while the owning project is visible, its sandbox is running and chat is ready. A likely failure can invoke AI analysis and then send the result to the tutor. Both requests use the account's AI quota. Turn the setting off to use **Help debug** manually instead. The existing `fix-errors` preference remains compatible.

- `stderr` alone does not mean failure. Ordinary HTTP access records (including 404), informational messages and common warnings do not trigger analysis. HTTP 5xx, recognized exceptions/build/runtime failures and unsuccessful command exits are candidates. Logs from successful foreground commands are not scanned.
- Classification is intentionally conservative and heuristic. Unrecognized formats, languages and warnings containing useful failure evidence can be missed. Terminal output remains available for explicit diagnosis; this is not comprehensive error detection.
- Transport chunks are joined before splitting lines. Recent failure context is bounded; command/stream/signature keys replace the old global rolling-log-length cursor.
- A project/sandbox session batches output after ten seconds and starts analysis at most once per minute. New logs update the pending batch without continually postponing it. Ignored and failed analyses count as attempts too. Deduplication is bounded in-memory history, not a durable exactly-once guarantee across page reloads.
- Failed analysis pauses with a visible **Retry analysis** action. Retry respects the minute budget. Project/account changes, expiration, unmount, disabling diagnostics or starting chat cancel obsolete analysis. Late results cannot submit into another workspace.

## Request boundary

`POST /api/errors` retains `{ sandboxId, lines, previous }` and its existing successful response shape. Authentication, same-origin checks, strict bounded JSON and sandbox ownership are required even for routine logs. Benign reports return `shouldBeFixed: false` without calling the AI provider or consuming AI quota. Real candidates require BotID and both AI quota checks.

The server's complete-request deadline is 45 seconds; the client allows 50 seconds for the complete response, including its body. Provider retries are disabled, output is bounded and results are schema checked. Interruption returns a structured recoverable error. Cancellation does not promise a refund or rollback of a provider request already dispatched. Structured lifecycle logs include only request IDs, outcomes and elapsed time, never command output or prompts.

The React/network repair follows the existing account-aware request helper and primitive store subscriptions; it adds no parallel chat store or duplicate subscription. The SDK client initializes before hydration for `/api/chat` and `/api/errors`. The authentication proxy allows only the exact SDK-owned challenge namespace, preserving authority validation and protection of unrelated routes. A regression check compares that namespace against the installed SDK rewrites.

## Verification

- Full local suite: **1,685 tests passed, 17 opt-in tests skipped**, across 112 passing test files. Lint, TypeScript, Node 24 production build, whitespace checks and production dependency audit pass.
- Classifier/session/request/component tests cover ordinary access logs, split records, repeated/rolling output, bounded context, explicit retry, rejected chat submissions, Strict Mode, account/project changes, expiration, stalled headers/body/provider work, malformed results, quotas and cancellation.
- `tests/live-preview.test.ts` passed against the local production app, hosted database and a disposable VM. Its real cookie-authenticated `/api/errors` checks prove routine reports skip analysis, anonymous access is denied, another user's sandbox is hidden, invalid origins/IDs are rejected and expired sandbox reports return 410. This does not invoke an AI model. Both users and the VM are cleaned up in the test's `finally` path.
- Browser QA created an owned blank workspace without AI, ran a Python HTTP server, loaded its embedded preview and reconnected it. Both HTTP 200 access records appeared in the terminal. Beyond the debounce period, no analysis notice or analysis lifecycle request appeared and the chat stayed empty/ready. Browser warning/error output was empty for this flow.
- The browser fixture confirmed cleanup of its disposable account, sessions, projects and sandbox. Existing user work was not deleted.
- A direct signed-out HTTP request reproduced the BotID asset's erroneous 307 sign-in redirect. After the narrow proxy repair, the same request returned 200 JavaScript. Ordinary workspace routes still require sign-in.

## Remaining release gates

Successful BotID verification must still be tested on an actual Vercel deployment. A local production server does not supply Vercel's production request context/OIDC, and a loaded challenge script is not proof that protected AI requests succeed. The previously observed Gateway credit failure also remains a separate live-generation gate. No protection was disabled to bypass either condition.

The browser check does not prove a real failure → provider analysis → tutor repair flow, customer sign-in delivery, full accessibility/responsive coverage or deployed background scheduling. One redacted server `ResponseAborted` event occurred during the preview flow without a browser error; its route/cause was not established, so a clean whole-session server-error gate is not claimed. See [SaaS release gates](./saas-release-gates.md).
