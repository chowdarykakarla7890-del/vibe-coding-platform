# Bounded file and snapshot recovery

Verified locally on 2026-08-28. These changes are not yet deployed.

The shared JSON reader now limits the entire body read to ten seconds, observes caller cancellation, rejects invalid UTF-8, and does not wait indefinitely for transport cleanup. It returns structured `408 REQUEST_INTERRUPTED`, `413 REQUEST_TOO_LARGE`, `415 UNSUPPORTED_CONTENT_TYPE`, or route-specific `400` errors. No file mutation begins for an invalid body. File-save requests also check cancellation after authentication and quota checks; once a durable write starts, cancellation does **not** imply rollback.

File and snapshot reads share a twenty-second deadline covering ownership lookup, source lookup, VM file opening and all file-body chunks. Cancellation closes an acquired stream and also disposes of a stream returned after the deadline. A stalled transport's `next()` or `return()` cannot keep the HTTP response waiting indefinitely. Database/SDK reads receive the same abort signal; drivers that ignore it may still finish in the background, but their late results cannot continue into subsequent file reads.

## Limits and receipts

| Interface | Bound / behavior |
| --- | --- |
| File creation | 4 KiB JSON body; safe path and strict fields |
| File save | 2 MiB JSON body; 256 KiB UTF-8 source; revision preserved |
| Snapshot read | 64 KiB request, at most 200 paths; duplicates read once |
| Snapshot response | Less than 4 MiB including JSON escape overhead; excess returns 413 and asks for a smaller batch |
| Snapshot restore | 4 MiB request; normal recovery already uses batches of at most 2 MiB |
| Source file | At most 256 KiB; UTF-8 text, no NUL bytes; a source BOM is preserved by the server |

Snapshot reads retain `files` and `totalBytes`, and add `skipped: [{ path, reason }]` plus `complete`. Reasons are `not-found`, `too-large`, or `not-text`; `complete` is false when any requested file is excluded. A failed or oversized request never returns a truncated successful backup. Restore rejects duplicate paths, file/directory collisions, unknown fields and invalid content before writing. All responses include a request ID and `private, no-store`.

Saved database source remains authoritative and readable after its VM expires. Deleted source returns its tombstone revision, and a database failure never falls back to stale VM bytes. Only unsaved VM files require a running owned sandbox. Snapshot reads/restores against an expired VM return recoverable 410 responses without resuming it. No saved source, drafts or legacy device data are cleared by these errors.

## Evidence and remaining gates

### Restore text-validation follow-up (2026-08-28)

The browser's restore preflight accepted NUL-containing source even though the snapshot API rejects it as non-text. Two regression tests reproduced both manual startup and restoration progressing into sandbox creation/upload with this invalid source. Both sides now share `restorableSourceFileSchema`: the complete saved snapshot is checked before any activity-setting write or VM creation. Invalid saved files are left untouched, not silently omitted or rewritten. Normal source, revision metadata, escaped JSON batching, and the server's strict unknown-field checks remain supported.

The seven focused recovery suites pass all 127 tests, including the two new preflight regressions. The full local suite passes 1,911 tests, with 17 opt-in tests skipped. TypeScript, lint, and whitespace checks pass. The existing deployed **My playground** still shows the expiration dialog after clicking **Close**; no browser warnings/errors or server error logs were returned during this check. This confirms the deployed dismissal defect but does not reproduce the separate original global application exception. Local controlled-dismissal and error-boundary regressions pass. No customer sandbox or saved work was modified.

These fixes are still local. The worktree also contains an unfinished authenticated database migration, so publishing the entire directory is not a safe isolated hotfix for the existing device-local production app. The production build was not rerun for this follow-up; several existing local servers share its build directory.

### Application error fallback follow-up (2026-08-28)

Both application error screens dereferenced `error.digest` and `error.name` without checking the thrown value. The installed Next.js boundary passes through the actual thrown value, including `null` and `undefined`. Regression tests reproduced secondary exceptions in both screens for those values and for an Error whose metadata getter throws. All three recovery boundaries now use a shared, guarded diagnostic reader; it never serializes the message, stack, or raw provider response. Retry remains explicit and no storage or source is cleared.

The ten new application-recovery tests and existing expiry, restoration, shutdown, and editor-recovery suites pass: 103 tests across six files. TypeScript, lint, and whitespace checks also pass. The production dialog still cannot be dismissed with Close; its console showed no warning/error during this recheck. The separate original global exception was not reproduced. These are local fixes only: no replacement VM, source mutation, database change, deployment, or browser-storage clearing was performed. The production build was not rerun for this follow-up.

### Saved-project production reproduction (2026-08-28)

The production alias still resolves to `dpl_91SxHF2W9hMFcy9GoVeSp4V58LZy` (READY). Opening the existing **My playground** through the project picker reproduces the expired-sandbox dialog. Clicking **Close** leaves that dialog open and the workspace inaccessible. Its saved chat remains visible beneath the dialog. No restoration, file write, customer sandbox creation/shutdown, or storage clearing was performed.

This confirms the broken dismissal on the deployed build, not the cause of the separate **CodeTutor could not load** global exception. No browser warnings/errors were captured during this reproduction; Vercel also returned no runtime error clusters for the preceding 24 hours.

The existing local recovery implementation already has controlled dismissal, an accessible reopen action, project-scoped restoration, a recovery-only error boundary, draft guards, cancellation and explicit retry. The focused `sandbox-dialog`, `sandbox-recovery`, `sandbox-expiration-api` and `file-explorer-recovery` suites passed all 65 tests on this recheck. These results do not establish that a production restoration succeeds. The local implementation remains undeployed and must be isolated from the unfinished authentication/database migration before a production hotfix is published.

### Latest verification

The 2026-08-28 recheck passed 1,349 unit/component/route tests (11 opt-in live suites skipped), TypeScript, lint, diff checks and the Node 24 production build. The build-blocking quota test fixture now includes the full rate-limit header contract. The earlier missing grading RPC types have been regenerated; that specific build blocker is resolved.

The deployed Playground loaded normally in a fresh browser tab with no captured console warnings/errors, and Vercel reported no runtime error clusters for the preceding 24 hours. This does not reproduce the user's saved-project state or prove the original application exception is fixed. No customer project, browser storage or sandbox was changed. The local restoration fixes remain undeployed; shipping this worktree would also ship the larger unfinished authenticated SaaS migration.

### Restoration acknowledgment follow-up

The final project request used after restoring source previously relied only on a fetch abort signal. Two regression cases reproduced indefinite waiting when headers or a JSON body reader ignored cancellation. Shared account reads and mutation receipts now settle within 20 seconds, observe cancellation and late failures, and do not publish or cache late results. They do not automatically retry writes.

After all source uploads are acknowledged, a failed final project acknowledgment no longer requests shutdown of the registered replacement. It returns `SandboxReopenRequiredError`; both the expiration dialog and activity startup offer **Reopen project**, not another restore/create operation. Reopening checks for an unsaved editor draft before reloading. Incomplete uploads still use the existing best-effort replacement cleanup. No saved files or browser storage are deleted by these controls.

Follow-up verification: 1,301 tests passed, 11 opt-in live suites skipped; lint had no errors (one existing unused-import warning in `tests/dsa-grading.test.ts`), and diff checks passed. TypeScript remains blocked by three existing missing RPC definitions in `lib/server/grading-evidence.ts` (`prepare_submission_grading`, `finish_submission_grading`, `read_submission_grading_summary`). A new production build/deployment was not attempted over that unfinished database work. The public site again loaded normally with no captured browser errors; the original global application exception remains unreproduced. These are verified local restoration fixes, not a claim that the reported production crash is resolved.

### Editor request settlement follow-up

File creation and editor saves could remain on “Creating…” / “Saving…” when a transport or response-body reader did not settle. Four regression cases reproduced this for missing headers and stalled response bodies. Both controls now bound the complete receipt wait to 35 seconds, abort the request, and ignore late receipts after timeout, unmount, sandbox replacement or account change. The shared receipt helper does not retry or roll back mutations.

A timed-out save preserves the latest draft and requires **Compare latest** before another save. The comparison uses the authoritative revision, so a server write that completed after the browser stopped waiting is not mistaken for a rollback. File creation retains the entered path and explains that the item may still be created; retries remain explicit and the existing server create-only protection is unchanged. Ordinary sandbox expiry remains separate from a fatal application error.

The 2026-08-28 local verification passed 1,293 tests (11 opt-in live suites skipped), including 104 targeted editor/expiry/recovery tests, lint, TypeScript, diff checks and the Node 24 production build. The production page loaded without captured browser errors and Vercel returned no runtime error clusters in the preceding 24 hours. This does **not** reproduce or establish the cause of the user's original global application exception. No browser storage was cleared, no customer sandbox was restored or stopped, and no deployment was made. The existing larger SaaS migration must not be promoted as an isolated loading repair.

- Regression suites: `request-body-deadlines`, `file-read-boundaries`, `file-write-cancellation`, `sandbox-file-read`, `snapshot-boundaries`, `file-response-headers`, `request-boundaries` and `sandbox-expiration-api`.
- The opt-in `live-source-resolution` suite passed against a rebuilt local HTTP server, hosted Supabase and one disposable VM. Added checks cover real snapshot reads/deduplication, missing-file receipts, authentication, another user's denial, origin enforcement, malformed restore requests, revisioned saved-source reads after stopping the VM, and 410 snapshot reads/restores. Both disposable accounts and the VM are cleaned up in `finally`; no AI request or email is sent.
- Stalled/aborted transports are simulated regression tests, not a claim that provider/network outages were induced in production.
- Production deployment, an authenticated browser recovery workflow, and the wider SaaS release gates remain open. Do not promote the entire unfinished migration as an isolated recovery patch.
