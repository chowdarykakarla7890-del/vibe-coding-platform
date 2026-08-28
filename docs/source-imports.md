# Atomic source import

Status, 2026-08-27: implemented locally and migrated to hosted Supabase; the app and staging cleanup schedule are **not deployed**. This imports the existing version-1 source-only JSON format. It is not full-history archive import or automatic migration of the legacy device database.

## User behavior

The project switcher's Import action opens a review/upload dialog. Source is uploaded to private staging and becomes visible as a new project only after all files are verified and committed. It always creates an active, ungraded Playground project. The original export, existing projects and unsaved editor drafts are untouched. A draft-discard confirmation is required only when explicitly opening the successfully imported project.

Chat/tool parts, activity association, completion status, scores, source revisions, sandbox IDs and preview URLs from the file never become authoritative cloud records. No code executes and no VM or AI request is created during import. The dialog states these source-only semantics before upload; full-history NDJSON archives are rejected explicitly.

Pause, close, a lost response or a network timeout are not treated as rollback. The browser retains an account-scoped import ID and source digest (no source contents or credentials) so the original JSON file can resume the upload. Retries use the same ID. A published receipt survives reload; Open imported project acknowledges it. Browser preferences must be available to start this recoverable upload.

Explicit Cancel staged import removes staged files only. Publication and cancellation share a database lock. If publication won the race, Cancel returns the intact project and the UI offers Open instead of deleting it. Retrying publication never overwrites later source edits. Deleting a published project prevents the same import receipt from recreating it.

## Protocol and trust boundary

- `POST /api/projects/imports`: strict metadata (`id`, `title`, `language`, `fileCount`, `sourceBytes`, `digest`), ten attempts/hour/account.
- `GET /api/projects/imports/:importId`: current owned receipt.
- `PUT /api/projects/imports/:importId`: up to twenty `{ path, content, digest }` files in a bounded JSON request.
- `POST /api/projects/imports/:importId`: empty JSON body publishes the complete source.
- `DELETE /api/projects/imports/:importId`: cancels staging, never deletes published project/source.

All routes require authenticated account ownership; mutations reject cross-origin mutations. Requests after creation share a 120/minute/account quota. Responses are private/no-store and failures have request IDs and structured error codes. No request-provided user ID is accepted. The RPC is security-invoker, service-only, and checks the explicit authenticated owner. Both private staging tables have RLS enabled and no browser table grants or policies (intentional default deny).

The server validates safe relative paths, binary/runtime exclusions, unique paths, file/directory conflicts, valid Unicode, no null bytes, 256 KiB/file, 200 files and 10 MiB total source. It recomputes each SHA-256, then verifies the exact count, bytes and aggregate digest before publishing. The aggregate is SHA-256 of `path:contentDigest\n` records ordered by UTF-8 bytes/PostgreSQL C collation. Hashes detect changes/corruption, not authenticity or safety of imported code.

One database transaction creates the project and saves all source through the existing revision-enforcing function. A failed publish leaves no visible partial project. Exact duplicate uploads are idempotent; changed duplicate paths are rejected. The API request is capped at 2 MiB; client batching accounts for JSON escaping. Source-file selection allows up to 61 MiB of encoded JSON so a valid 10 MiB source snapshot made of escaped controls is not incorrectly rejected by the former 12 MiB download-file limit.

## Retention

Only one unfinished upload/account is allowed; it expires after thirty minutes. Cancelled receipts expire after one day. Successful receipts retain only metadata and remain until account deletion, allowing lost-receipt retries without recreating or overwriting a project. Project deletion unlinks its receipt but keeps that small tombstone; account deletion cascades all receipts/staging. This prevents even a delayed begin after cleanup from reusing the deleted project's import ID.

The existing authenticated archive-cleanup worker now also purges at most five eligible imports per invocation. It never removes published projects. A subsequent same-account begin also removes that account's expired, non-published staging. The worker's deployment, capacity monitoring and unattended retention verification remain release gates. If browser preferences are lost, an unfinished upload on another browser can occupy the staging slot until it expires; cross-device pending-upload discovery is not implemented.

## Evidence

- `supabase/tests/source-imports.sql`: rolled-back hosted checks for private grants/RLS, ownership, staging quota, invalid hashes/paths, file/directory overlap, all-or-nothing batches, incomplete publication, duplicate publish, preservation of newer edits, cancellation, expiry, project deletion and cleanup. A full 10 MiB fixture of heavily JSON-escaped source publishes exactly forty files with the original bytes.
- `scripts/verify-source-imports.mjs`: real local Next.js HTTP routes with two disposable hosted users; cookie authentication, CSRF, strict input, cross-user denial, RPC grants, concurrent publication, retries, revision preservation, cancellation and quota headers. Test accounts/projects are removed and sessions signed out in `finally`; no paid VM, AI call or email is used. The broader authenticated integration script also includes these checks.
- Unit/route/component tests cover source-only authority stripping, bounded escaped chunks, Unicode hashing/order, interruption/body-read cancellation, account replacement, reload receipts, draft guards and stale completions after unmount.
- The complete suite passes 677 tests, with four opt-in live VM tests skipped. Lint, TypeScript, production build and the production dependency audit pass. The build initially encountered local disk exhaustion; removing only unused, regenerable Turbopack build cache resolved it without touching source or user data.
- Migration `20260827164507_atomic_source_imports.sql` is applied and generated types updated. Its SQL hash matches hosted migration history. Post-migration advisors report only the existing password-protection warning, intentional private-table RLS notices and informational index/Auth notices.
- A follow-up hosted test reproduced a delayed-retry resurrection after cleanup purged a deleted project's receipt. Migration `20260827171653_source_import_tombstone_retention.sql` retains published metadata tombstones; the same test now passes, along with the complete 10 MiB source import fixture. No source content is retained in tombstones.

The local sign-in page rendered without a framework error overlay. Signed-in visual upload verification, cross-device pending-import discovery, browser memory/load testing, isolated Preview and deployed cleanup verification remain outstanding. Full-history NDJSON files have a separate [Import archive flow](./archive-imports.md), including combined v3 archives across repeated recoveries. History stays unverified evidence rather than live tool/score authority.
