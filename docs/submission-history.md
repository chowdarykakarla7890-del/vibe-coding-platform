# Immutable activity submissions

Status: implemented in the current SaaS worktree and hosted database; application deployment is still pending. Evidence persistence supports AI review and trusted behavioral grading for all 15 DSA activities in five languages. The remaining catalog is not a completed trusted-grading system. See [trusted grading scope and limits](./trusted-grading.md).

## What is submitted

`POST /api/activities/verify` accepts the existing project/activity/sandbox IDs, model, language and optional reflection. It does not accept browser-supplied source or an activity manifest. The authenticated server loads the owned activity and validates the registered sandbox's project ownership. AI-only review reads durable saved source and permits an expired sandbox without opening or resuming a VM. Registered trusted graders require a running, prepared, owned VM; expiration retains the attempt without a score and returns `410 SANDBOX_EXPIRED`. Historical submission files remain readable without a live VM in either mode.

The service-only `begin_activity_submission` transaction takes the account quota lock, project source lock and project row lock in that order. It copies every nondeleted saved file, sorted by path, with its revision, plus the activity manifest, language, model and reflection. This serializes with editor/capture batch writes: a submission contains one complete saved revision set, not a mixture from different points during a save. Unsaved editor drafts are not included; the UI blocks Submit while a draft is dirty.

Unresolved source conflicts and queued/capturing/acknowledging foreground command captures block submission. Long-running background servers do not indefinitely block saved-source assessment. This policy does not establish that all unpersisted background VM edits have been captured.

The source copy is stored in `submission_sources`, with a SHA-256 digest of its canonical PostgreSQL JSON representation. Identical files within one project share that immutable source row. `activity_submissions` stores each attempt's independent source revisions and frozen activity context. Owner-based SELECT RLS protects both tables; anonymous/browser writes and all browser calls to the writer RPCs are denied. Composite foreign keys prevent cross-project/account associations. No client metadata claim supplies authorization.

## Storage and read limits

| Limit | Enforcement |
| --- | --- |
| 200 files; 256 KiB per saved file; 10 MiB total source contents | Saved-source validation and submission transaction |
| 50 MiB retained evidence per project; 200 MiB per account | Combined serialized source, attempt metadata and reserved grading evidence, checked atomically |
| 1,000 attempts per project; 5,000 per account | Atomic count quota, including failed/interrupted attempts |
| 1,000,000 bytes per manifest; 4,000 characters per reflection | Database constraints plus API validation |
| 64,000 UTF-8 bytes of complete JSON source evidence | Current AI reviewer; never silently truncates |
| 20 history entries per page; one source file per file request | Authenticated, bounded history endpoints |

The evidence byte quota counts `octet_length(files::text)` plus the serialized manifest, source-version list and UTF-8 reflection for every attempt. Trusted grading additionally reserves the serialized plan size plus 128 KiB for its report before running code. Generated stored columns calculate these counts, so a caller cannot forge them. It includes JSON escaping and metadata even when the source blob deduplicates. It is a logical evidence-payload quota, **not a total physical database-size or billing cap**: row/index overhead, assessment feedback, chat and other tables are separate. Assessment feedback remains bounded to 64 KiB per record and one record per submission.

Quota rejection does not insert a submission or orphan source blob. An idempotent retry of an existing request still works at capacity. Finalizing an existing attempt does not charge its immutable source again. No history is silently pruned to make room. Deleting a project cascades its evidence and scores; download anything needed first. The [full project archive](./project-archives.md) preserves submissions, frozen files and assessments in an inspectable NDJSON export. Existing source-only JSON export omits this history; the history UI also downloads individual submitted files. [Full-archive recovery](./archive-imports.md) supports v2/v3 and preserves earlier imported history in re-exports. Imported historical scores are unverified archive evidence, not new trusted scores or execution authority. Deployment and signed-in browser round-trip verification remain outstanding.

## Assessment lifecycle

- The user/source snapshot is retained before AI or trusted execution starts. No learner-owned test script determines a score.
- All 15 registered curated DSA activities use **Trusted checks**, with `verification_kind: command` and `ai_assessed: false`. The host checks returned values against server-controlled cases; a process exit or learner-printed score cannot award points. This path consumes assessment quotas and owned-command quotas, not AI quotas. It never silently falls back to AI on execution failure.
- Other activities use explicitly labeled **AI assessed** review and run no commands. Missing/blank required source or evidence over the reviewer's limit produces no score, while retaining the failed attempt where creation succeeded.
- Provider errors and cancelled requests mark pending submissions failed. Pending records past their five-minute deadline display as interrupted; the next begin operation marks stale pending rows failed. Completed scores cannot be overwritten by late cleanup.
- `record_submission_assessment` atomically inserts one score and completes its submission. It compares current saved revisions to the submitted revisions under the project source lock. Passing older code records that result but does not mark newer project code complete.
- The response includes `submissionId`, `sourceDigest`, and `sourceCurrent`. History calls the latter `sourceCurrentAtAssessment`: it records the comparison at grading time, not an assertion that no edit has happened since.
- The application verifies the assessment receipt identifies the exact requested submission. An uncertain save directs the user to history instead of claiming that a grade was definitely lost or automatically repeating a paid call.

## Verification deadlines and cancellation (2026-08-28)

The verification route now bounds the complete operation to 150 seconds, including authentication, ownership, quotas, immutable source capture, grading and the assessment receipt. AI-only review has a separate 60-second wait, a 4,096-token output cap and zero SDK retries. Cancellation/deadline checks after awaited boundaries prevent a late lookup, source receipt or grade from starting the next stage. The output is schema-validated before any score is recorded. AI review requires BotID proof, with the matching client-protected route; deterministic graders retain authenticated ownership and assessment/command quotas without depending on AI or BotID. Oversized or missing evidence still fails before any paid provider call.

Failure cleanup has its own five-second receipt bound. It can only close a pending submission, never change a completed score. A late source-creation receipt is observed and receives best-effort cleanup too. A process terminated before that cleanup completes can leave a pending attempt until the existing five-minute lease expires; history then labels it interrupted. Deadlines bound waiting, not rollback or guaranteed cancellation of a database/provider operation already dispatched.

The client bounds headers and body decoding to 160 seconds, rejects late results, and exposes **Cancel verification** plus a persistent notice directing the learner to submission history. Cancellation, account/project navigation and unmount cannot publish an old result into the new workspace. Source files are never rewritten by submission. An acknowledged assessment stays visible if the subsequent progress refresh fails or exceeds 20 seconds. No timeout or cancellation automatically resubmits or fabricates a score.

Regression tests first reproduced three server waits and two client waits that never settled. The repaired focused suite passes 161 tests (`activity-verification`, `activity-workspace`, `botid-client`), including stalled lookups/provider/cleanup/receipt, malformed scores, bot denial, late completion, explicit cancellation/retry and progress-refresh failure. The full suite passes 1,772 tests (17 opt-in live tests skipped), with TypeScript, lint, Node 24 production build, toolchain validation and production dependency audit passing. The cleanup fixtures require Python 3.11+; this run used the bundled Python 3.12 through `CODETUTOR_TEST_PYTHON`, not the older system default. Only rebuildable `.next/cache/turbopack` data was removed to make build space; no source or saved projects were removed.

The hosted two-user submission check also verifies that browser RPC calls are denied, a different user cannot close an attempt, cleanup cannot erase a completed score, and a failed attempt rejects a late score. These checks use synthetic assessments and disposable source, not AI or new VMs. Successful live provider review, deployed BotID, signed-in visual cancellation and the broader release gates remain unverified; this is not a production deployment.

## History APIs and interface

- `GET /api/projects/:projectId/submissions?after=:submissionId`: owned keyset-paginated history ordered by creation timestamp and UUID. Timestamp ties cannot skip or duplicate rows.
- `GET /api/projects/:projectId/submissions/:submissionId`: frozen metadata, paths/revisions, assessment and nullable `gradingSummary`. Older attempts have no fabricated check-by-check evidence; new summaries contain fingerprints and outcomes, not private inputs/output.
- `GET /api/projects/:projectId/submissions/:submissionId?file=:index`: one validated file and revision from the immutable source copy, without a VM call.

The workspace's Submission history dialog loads on demand. Selecting a file, switching project/account, or closing the dialog aborts obsolete reads. It displays failed/interrupted attempts without fabricated scores, warns when the assessment applied to older source, and allows read-only viewing/download of submitted files. Completed results distinguish AI assessed from Trusted checks; unscored attempts have nullable `aiAssessed` and no invented assessment label. Responses are private/no-store and require authenticated ownership and read quotas.

The client bounds the entire list/detail/file read to 20 seconds, including stalled headers and response-body readers that ignore cancellation. A timeout offers explicit retry without clearing stored history. Six regression cases reproduced indefinite loading before this fix and now verify timeout settlement plus rejection of late results after retry. These transport-failure tests are simulated; they do not claim a live provider outage was induced.

See [durable private grading evidence](./grading-evidence.md) for plan/report storage, score enforcement, safe exports, migration hashes and live verification.

## Verified and still required

Verified on 2026-08-27:

- `scripts/verify-activity-submissions.mjs`: real hosted two-user RLS, denied browser writes/RPCs, immutable content, deduplication, save/submission races, score idempotence, current-source completion, interrupted/failed attempts, foreground-capture/conflict gates, project and cross-project account quota races, and cascade cleanup. It signs out and deletes disposable accounts in `finally`.
- `supabase/tests/submission-storage.sql`: hosted transaction rolled back in full; exact 50/200 MiB boundaries using real payloads, generated UTF-8/JSON byte counts, metadata quotas with deduplicated source, no orphan writes, at-capacity retry/finalization and independent account capacity. No customer rows are selected or modified.
- `scripts/check-activity-submissions.mjs` through `scripts/verify-auth-projects.mjs`: cookie-authenticated HTTP history/file ownership, old-source reads after edits, pagination ties, malformed IDs/indexes, expired-VM independence and oversized evidence retained without a provider call.
- Component/unit tests cover lifecycle cancellation, immutable evidence limits, exact receipt identity, stale-account reads, retries and history UI.

Those earlier evidence checks use no AI provider, paid VM or email. The subsequent `tests/live-dsa-submission.test.ts` passes against the rebuilt local HTTP app, hosted database, two disposable accounts and one owned paid VM: immutable-source grading, correct/forged results, cross-user and CSRF denial, interrupted/expired attempts without scores, released command slots, retained historical files and no AI quota consumption. The VM is stopped and accounts signed out/deleted in `finally`. The five-language matrix and process-isolation checks are documented in [trusted grading](./trusted-grading.md).

Signed-in visual browser verification, the funded live model matrix, deployed archive recovery, the remaining activity-specific graders/content, isolated Preview and production release gates remain outstanding.

PostgreSQL generates stored columns after BEFORE triggers; the immutability trigger compares only base columns so valid status transitions remain possible. See [generated columns](https://www.postgresql.org/docs/17/ddl-generated-columns.html) and [Supabase function security](https://supabase.com/docs/guides/database/functions#security-definer-vs-invoker). The latest advisors report the existing [leaked-password protection warning](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection) and informational [unused-index](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index)/[Auth connection allocation](https://supabase.com/docs/guides/deployment/going-into-prod) notices; no new security warning was introduced by these migrations.
