# Saved-project archives

Status, 2026-08-27: implemented in the local SaaS worktree and hosted database. The application and cleanup schedule are **not deployed**. Version-3 exports combine current saved work and earlier imported history in one file; version-2 imports remain supported. See [full archive recovery](./archive-imports.md).

## What the download contains

The project switcher's **Full project archive** action creates an NDJSON file containing saved project metadata, all chat messages and their statuses, revisioned source including deletion tombstones, source-conflict metadata and captured/saved/reviewed copies, frozen submissions and their source, assessments, relevant activity manifests, the project's portfolio entry, and source-capture status metadata.

It is distinct from **Source export**, the existing source-only JSON format accepted by Import source. Individual submitted files and conflict copies can also be downloaded from their existing review interfaces.

The source-only Import source action uses private staged uploads and atomic publication, with pause/resume and explicit opening of the new ungraded Playground project. Import archive is a separate action for this NDJSON format. It preserves original history without replaying tools or granting trusted scores/activity association. See [source import protocol](./source-imports.md) and [archive recovery](./archive-imports.md).

Unsaved editor drafts, uncaptured VM changes, dependencies, running processes, other projects, account settings and live sandbox credentials are not included. The UI blocks starting an export while the current editor draft is dirty. Exporting neither stops the VM nor proves that its latest changes have reached the database. Save files and finish source capture first; a VM that expires before capture can still lose unpersisted changes.

Explicit database projections omit account identifiers and runtime authorization fields. Structured credentials are recursively removed from message parts. Ordinary source and message strings are preserved, not scanned or rewritten: they may contain secrets supplied by the user. Keep exported files private.

## Consistency and transport

`create_project_archive` verifies ownership and copies every record with one `INSERT … SELECT` statement. All UNION branches share one PostgreSQL statement snapshot. Later writes do not change the frozen archive, and browser pagination never reads the mutable original tables. Complete atomic source batches appear before or after capture, not half-applied. This is a snapshot of saved database state, not a transaction spanning a live VM and the database.

The temporary archive lives in two private, RLS-enabled tables. Browser roles have no table grants or RPC execution rights; the server invokes security-invoker functions after authentication and ownership checks. Default-deny RLS without browser policies is intentional for these staging tables.

- `POST /api/projects/:projectId/archives` accepts only `{ archiveId }` and returns a manifest receipt. Creation is limited to three requests/hour/account.
- `GET /api/projects/:projectId/archives/:archiveId?after=:ordinal` returns consecutive records and the next cursor. Reads are limited to 300 requests/minute/account.
- `DELETE /api/projects/:projectId/archives/:archiveId` removes only the owned temporary copy, never original project data.

Responses are private/no-store. Mutation routes enforce same-origin checks. Missing, expired, oversized and competing archives produce structured errors. Creation for the same project reuses an existing unexpired copy; creation for another project conflicts until that copy is removed or expires.

| Bound | Enforcement |
| --- | --- |
| One temporary archive/account; 30-minute expiry | Database and ownership-checked reads |
| 50,000 records; 256 MiB encoded record payload | Database constraints; failure rolls back capture |
| 2 MiB encoded payload/record | Database and client schema |
| 20 records/page, normally at most 1 MiB of payload | Database paging; one larger first record is allowed |
| 20-second page deadline; 10-minute total download deadline | Client, including body reads |
| Up to ten quota pauses, each capped at 60 seconds | Abortable `Retry-After` handling without restarting capture |

Payload limits count UTF-8 JSON bytes, not JavaScript character length. They exclude database/index overhead and the download's envelope/escaping overhead; they are not a physical storage, browser memory or billing cap. Each conflict version and submitted file travels separately so multiple valid large files do not overflow one response. Boundary tests include control characters with heavy JSON escaping.

The file starts with a `codetutor-project-archive` version-3 manifest (an existing staged v2 file retains v2). Each following envelope contains an ordinal, the JSON record string, and its SHA-256 digest. Earlier imported history uses flat section markers and envelopes with `sectionId`/`sectionIndex`; the original payload bytes are not re-encoded. Current and historical records share the same atomic snapshot and total limits. The client verifies digests, project identity, ordering, pagination, total count/bytes, and complete section integrity before allowing a successful download. A final `complete: true` record closes the file. See the [section and digest protocol](./archive-imports.md#version-3-history-sections).

These hashes detect transport corruption, **not authenticity**: someone editing an archive can calculate new hashes. Archive import therefore treats histories, scores, manifests and tool parts as untrusted evidence and does not grant tool authority or trusted scores.

## Cancellation and retention

Closing the dialog, switching project/account or cancelling aborts obsolete downloads. Cleanup has its own bounded signal but remains bound to the originating account; it never borrows a replacement account's cookies. Failed cleanup does not delete project data. Expired copies are inaccessible, but physical deletion needs the cleanup worker or a subsequent same-account create.

`/api/internal/archive-cleanup` requires the configured worker secret. It runs independent bounded cleanup operations for export staging, source-import staging, and archive-import staging, each deleting at most five eligible jobs per invocation. Published projects and import tombstones are not removed. The checked-in five-minute Vercel cron is **not deployed**. Deployed cleanup, capacity/backlog monitoring and interrupted-download retention must be verified before release. Project/account deletion cascades its temporary copies.

## Verification

- `scripts/verify-project-archives.mjs`: hosted database checks with two disposable accounts, 1,105 messages, immutable frozen source/submission/conflict copies, concurrent source-batch capture, idempotent creation, cross-owner denial, denied browser RPCs, structured credential exclusion, complete pagination and staging/project cascades. Fixtures are removed in cleanup; no paid VM, AI call or email is used.
- `supabase/tests/project-archives.sql`: rolled-back hosted transaction covering RLS/grants, expiry, constraints, byte accounting and large escaped source/conflict records. The large conflict fixture failed before the split-copy migration and passes afterward. Counter-limit constraints are tested; this is not a full 256 MiB throughput benchmark.
- `scripts/check-project-archives.mjs`, through `scripts/verify-auth-projects.mjs`: actual cookie-authenticated local HTTP routes, malformed input, CSRF, owner isolation, hashes, quotas and deletion of staging only.
- Unit/component/route tests cover incomplete/corrupt pages and sections, bounded schemas, UTF-8 integrity, final receipts, cancellation, account changes, quota pauses, duplicate clicks, dirty drafts, retry and cleanup authorization. The full suite passes 750 tests, with four opt-in live tests skipped; lint, TypeScript and production build also pass.

Combined/transitive recovery passes rolled-back database tests and real local HTTP round trips; the original-file download is now optional. Large-device-memory behavior, signed-in visual/browser verification, isolated Preview deployment and deployed cleanup/load checks remain release gates. See [SaaS release status](./saas-release-gates.md), [source consistency](./source-consistency.md), [archive recovery](./archive-imports.md) and [submission history](./submission-history.md).
