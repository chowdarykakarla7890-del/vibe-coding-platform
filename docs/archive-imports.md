# Full archive recovery

Status, 2026-08-27: implemented in the local SaaS worktree and hosted Supabase. The application and cleanup schedule are **not deployed**. Authenticated HTTP, database, and component checks pass; signed-in visual/browser and large-device/load checks remain release gates.

## What is recovered

**Import archive** accepts version-2 and version-3 NDJSON files created by **Full project archive**. It validates the entire selected file before staging any records. When all records are present and verified, one database transaction creates a new active, ungraded Playground project, restores only the current saved active source, and attaches immutable original archive evidence. No code, tool, AI request, or VM runs during import.

All original record strings, checksums, ordering, and manifest fields are retained: project metadata, source/tombstones, chat/tool parts, conflicts and copies, submissions and source, assessments, activities, the project portfolio entry, and capture metadata. Original IDs, timestamps, revisions, completion state, and scores remain inspectable as evidence.

Imported evidence is not an authoritative conversation, activity association, or assessment. It does not replay tool callbacks, authorize a sandbox, execute a generated command, or contribute to verified progress. Active source starts at revision 1 in the new project; the original revisions remain in its archive. Its source can later be restored into an owned sandbox through the existing explicit recovery flow.

The project switcher's **Imported history** action shows paginated, read-only records with bounded plain-text previews. It never renders foreign Markdown/HTML or invokes chat-part components. **Download original archive** returns every original record without truncation. The viewer's 10,000-character preview limit does not modify stored evidence.

New **Full project archive** exports use version 3 and combine current saved records with all prior imported evidence in one file. Repeated import/edit/export cycles retain flat historical sections instead of recursively wrapping or duplicating old record strings. Historical source is never applied over current source during recovery. **Download original archive** remains an optional exact copy of the file originally imported, not a required second backup. Unsaved drafts and uncaptured VM changes remain outside the backup.

### Version-3 history sections

Current records come first, starting with the current project. Each earlier project then has one small `archive-section` marker with its original manifest/digest and the count, UTF-8 bytes and digest of that project's root records. Its following envelopes add a canonical lowercase `sectionId` UUID and contiguous `sectionIndex` starting at 1. Markers have neither field. No root record may follow a historical section; markers cannot themselves be historical records.

Raw payload checksums still use SHA-256 of the exact UTF-8 record string. The v2 aggregate hashes `index:sha256\n`; the v3 aggregate hashes `index:sha256:sectionId:sectionIndex\n`, using an empty section ID and position `0` for root records and markers. Each section's root digest uses its local index with the v2 digest-line format. Validation checks its project identity, count, bytes and root digest. Original whole-file digests remain provenance, not signatures or claims of verified historical scores.

The server enforces the same boundaries at upload/publication, binds duplicate retries to section metadata as well as bytes, and scopes record-key uniqueness to the root or its section. Limits apply to the complete combined archive, including markers. Exceeding them fails atomically; no history is silently omitted. An already staged v2 export can still be downloaded and imported unchanged.

## Resumption and atomic publication

The client streams the selected immutable Blob twice: a complete integrity preflight, then bounded uploads. It retains only a per-account import ID, digest, and manifest fingerprint in browser preferences, not source or credentials. A published receipt can be reopened after reload. Existing projects, the original file, and unsaved editor drafts remain unchanged; discarding a draft requires confirmation only when explicitly opening the completed project.

Uploads are ordinal, hash-verified, and idempotent for identical bytes. Gaps and changed duplicate records are rejected. A failed batch rolls back all of that batch. Publish verifies counts, UTF-8 bytes, the aggregate digest, safe source paths, namespace conflicts, and source limits under one account lock before creating any visible project. The source write and evidence attachment share that transaction.

Pause, close, timeouts, and account changes abort obsolete work but do not imply server rollback. Retry with the same file and ID. Cancel removes only unpublished staging. If publication wins the race, cancellation returns the existing project intact. Retrying publication never overwrites later edits.

Deleting an imported project cascades its archived content and source. A small published receipt remains until account deletion, with its project reference cleared; this tombstone prevents delayed begin/publish retries from recreating a deleted project. Cancelled and expired unpublished uploads are eligible for cleanup.

## Ownership, APIs, and bounds

- `POST /api/projects/archive-imports`: strict `{ id, manifest, digest }`.
- `GET /api/projects/archive-imports/:importId`: owned receipt.
- `PUT /api/projects/archive-imports/:importId`: `{ records: [{ index, record, sha256, sectionId?, sectionIndex? }] }`. Section metadata is a v3-only pair.
- `POST /api/projects/archive-imports/:importId`: empty JSON body publishes.
- `DELETE /api/projects/archive-imports/:importId`: staging cancellation only.
- `GET /api/projects/:projectId/imported-archive?after=:ordinal`: owned evidence, labeled `imported-unverified`.

Every route authenticates the user; project reads verify ownership and import operations use only that authenticated identity. Mutations require same origin. Responses are private/no-store and errors have safe messages, codes, and request IDs. The three private tables have RLS and no browser grants or policies; service-only security-invoker functions repeat ownership checks. Hashes detect corruption, not authenticity or code safety.

| Limit | Enforcement |
| --- | --- |
| 50,000 records / 256 MiB payload per archive; 2 MiB per record | Client, API, database |
| 520 MiB selected NDJSON file; bounded UTF-8 lines | Streaming client preflight |
| 20 records / approximately 4 MiB encoded request | Client/API; DB allows small JSONB whitespace overhead |
| One unfinished archive/account; two-hour expiry | Database |
| 512 MiB retained/reserved archive payload per account | Account-locked database reservation |
| 200 active source files / 10 MiB total / 256 KiB per file | Preflight and atomic database publication |
| Ten begins/hour; 120 import operations/minute | Shared source/archive import quotas |
| 20-second client request; 15-second server database deadline | Abortable requests and body reads |
| 45-minute import; up to sixty bounded quota pauses | Client; paused imports remain resumable |
| Evidence pages: 20 records, normally 1 MiB, one larger first record allowed | Database |
| Evidence download: 15 minutes, up to twenty quota pauses | Client; original content remains unchanged |

Byte limits count logical UTF-8 payload, not physical database/index overhead or billing. JSON envelope escaping can enlarge downloads. These are bounded functional limits, not a completed 256 MiB throughput or low-memory-device benchmark.

The existing secret-protected archive-cleanup worker now runs three independent, 20-second-bounded cleanup RPCs in parallel. Each removes at most five eligible staging jobs. It does not remove published project data or archive tombstones. The cron remains undeployed; unattended retention, backlog, and capacity monitoring must be verified before release.

## Verification

- Hosted migrations `20260827170319_project_archive_imports.sql`, `20260827171419_archive_import_ownership_index.sql`, and `20260827173133_transitive_project_archives.sql` are applied; checked-in SQL hashes match hosted history and regenerated public types are unchanged by the private v3 columns/helpers.
- `supabase/tests/transitive-archives.sql` first reproduced omitted imported chat. The repaired rolled-back database test covers four generations, exact bytes, flat sections, current-only source restoration, corrupt section digests/order, atomic failed batches, ownership, deletion, retries and SQL NULL pair constraints. The v2 suite still passes after the migration.
- `supabase/tests/archive-imports.sql` runs in a rolled-back transaction. It checks RLS/grants, two-user isolation, corrupted/order/unsafe input, atomic counters, incomplete publish, idempotency, all record kinds, oversized-page retention, non-replayed history, unchanged newer edits, cancellation, content cascades, deleted-project tombstones, and expired staging cleanup.
- `node --env-file=.env.local scripts/verify-archive-imports.mjs` runs only against a local app (default port 3112). Two disposable hosted accounts exercise actual export → import → two combined re-export/recovery cycles, cookies, CSRF, IDOR, private RPC denial, corrupted input, concurrent publish, newer edits, and deletion. Every original exported record is compared byte-for-byte. Accounts/projects are removed and temporary sessions signed out in `finally`; no email, AI call, or VM is used.
- Unit/route/component tests cover streamed UTF-8 parsing, every record kind, malformed/truncated/trailing records, source limits, source namespace conflicts, JSON escaping, cancellation and stalled bodies, account changes, lost commit receipts, original download integrity, draft guards, and plain-text history rendering.
- The local sign-in route renders meaningful UI without a framework error overlay. This does **not** establish signed-in visual import, email delivery, OAuth, or real-device memory behavior.
- The complete local suite passes 750 tests with four opt-in live VM tests skipped; lint, TypeScript, production build and the production dependency audit pass. This includes v3 client downloads/uploads, section boundaries across pages, large escaped records without recursive growth, and rejection of corrupt sections before a successful download. Post-migration advisors report no new warning; remaining security notices are intentional private-table default-deny RLS and the existing password-protection warning.

Remaining work: explicit legacy-device migration, cross-device pending-upload discovery, signed-in visual/axe tests, capacity/load checks, isolated Preview deployment, and deployed cleanup verification.
