# Durable grading evidence

Updated 2026-08-28. Implemented in the local authenticated SaaS application and hosted `codetutor` database; the application is **not deployed**.

## Retention and trust boundary

Each new trusted DSA or code-Challenge submission retains its exact 24 test inputs and labels before execution, bound to its owner, project, immutable submitted source digest, activity and language. The plan also records the check version, harness fingerprint and normalized trusted-runner invocation fingerprint. A database trigger seals the canonical UTF-8 JSON SHA-256; callers cannot replace that digest or rewrite the plan later. The [Challenge extension](./challenges.md) reuses this schema and passed the real authenticated API/database/VM evidence and post-expiry archive checks without a new migration.

After isolated execution, the application records the bounded observed output, failure category and host-computed pass/fail for each case. The report must be complete before a trusted assessment can be stored. The database enforces `floor(100 × passed / 24)`, completion only at 24/24, and command-based verification. A compilation failure has no case results and earns zero. Invalid/incomplete infrastructure results, cancellation and expired environments do not earn fabricated scores.

Plan preparation and report completion are separate, idempotent operations. An interrupted attempt can retain a prepared plan without a completed report. A lost report acknowledgment does not authorize a score: the application requires a validated acknowledgment first. Retried plans/reports must match exactly; completed evidence is immutable. Historical assessments predating this feature remain readable and unchanged.

The exact cases and observed output live in `private.submission_grading`, with RLS enabled and no browser-role table or RPC grants. Service-only, security-invoker functions check the explicit owning account and project. No authorization uses editable user metadata. Project/account deletion cascades retained evidence. Default-deny advisor notices are intentional; do not add public policies to silence them.

## Limits

| Item | Limit |
| --- | --- |
| Plan | Exactly 24 cases, at most 128 KiB serialized JSON |
| Completed report | At most 128 KiB serialized JSON |
| Per-case stored output | At most 8,192 characters, also subject to the total byte cap |
| Retained submission evidence | 50 MiB/project and 200 MiB/account across source, metadata and grading reservations |

Plan insertion reserves its serialized bytes plus the full 128 KiB report allowance before code runs. The same account-level database lock governs source, metadata and grading admission. Reports can therefore finish at the exact storage quota without requiring more space. A failed admission creates no orphan evidence. This is a logical payload quota, not a physical database billing cap; indexes, row overhead and other application tables are separate.

## Safe history and export

The owned submission-detail API adds nullable `gradingSummary`:

- `version`, `checkVersion`, `planDigest`, `sourceDigest`, `harnessDigest`, `runtimeDigest`.
- `caseCount`, `status` (`prepared` or `complete`), nullable `passedCount` and `compileFailure`.
- Ordered outcome categories plus creation/completion timestamps.

It never returns private case inputs, labels or captured output. The UI labels older assessments with no retained checks honestly, distinguishes prepared evidence from completed grading, and provides keyboard-accessible per-check outcomes. List/detail/file reads have a full 20-second deadline with explicit retry and late-response rejection.

Full v2/v3 project archives include this safe optional summary within submission records. Transport envelopes still require record checksum, sequence, cursor and total-byte validation. Imported summaries remain unverified historical evidence; they cannot award a new trusted score, create private grading records or execute code.

## Migrations and verification

Both files match hosted migration history byte-for-byte:

- `20260827213939_durable_grading_evidence.sql`: SHA-256 `a7582a09371405724fdd37e5b82963fb2b67515a421d08f19c9ceefd05c32628`.
- `20260827215054_grading_evidence_fk_index.sql`: SHA-256 `70d593c06b850627c66fdce6446c4a65cea81c63f3713608c80a616fa2abd1fe`.

All 39 local migration versions match hosted names/versions. Generated public TypeScript types match the live schema. The new composite foreign-key index warning is resolved. Existing [leaked-password protection](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection), [unused-index](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) and [Auth connection allocation](https://supabase.com/docs/guides/deployment/going-into-prod) notices remain. Private-table [default-deny notices](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy) do not indicate public access.

Verified:

- Hosted `supabase/tests/grading-evidence.sql`: explicit role/grant checks, two-user isolation, plan/report validation, immutability, idempotence, digest/source binding, score matching, safe archives and cascade deletion. All synthetic fixtures roll back.
- Hosted `supabase/tests/submission-storage.sql`: real serialized payloads at the exact 50/200 MiB boundaries, report reservation/finalization, denied new plans, unchanged-source deduplication, no orphan writes and independent account capacity. All synthetic fixtures roll back.
- Unit/component/route coverage: server RPC arguments and validated receipts; no execution before plan persistence; no score before report acknowledgment; safe summaries; owner filtering; malformed/missing data; history display, cancellation and six reproduced stalled-header/body cases.
- Opt-in `tests/live-dsa-submission.test.ts`: rebuilt local HTTP app → cookie-authenticated hosted Supabase → real owned VM. Correct/incorrect scores, source immutability despite VM-only tampering, cross-user/anonymous/CSRF rejection, cancellation without a score or surviving grading process, expired-VM history and exact safe-summary export all pass. Export validation decodes the hashed record envelopes and checks total bytes. The initial export assertion incorrectly inspected envelopes directly; the corrected test passes without changing the production archive contract.

The successful live run took about 42 seconds, consumed no AI credits and sent no email. Its two disposable accounts were signed out/deleted and its VM stopped in `finally`; the preceding failed assertion run also completed cleanup. No customer project or source was changed.

Final local checks pass 1,355 unit/component/route tests (11 opt-in live suites skipped), lint, TypeScript and the Node 24 production build. The production dependency audit reports no known vulnerabilities. These checks do not replace isolated database replay or a deployed smoke test.

Run the live check only against a rebuilt local application using the ignored environment file:

```sh
TEST_APP_URL=http://127.0.0.1:3112 RUN_LIVE_DSA_SUBMISSION=1 \
  node --env-file=.env.local node_modules/vitest/vitest.mjs run tests/live-dsa-submission.test.ts --maxWorkers=1
```

## Not yet proved

Retaining exact inputs/output and fingerprints is not byte-identical historical replay. Old compiler/VM images, executable graders and host-oracle implementations are not archived, and no replay endpoint is implemented. The current fingerprints identify the harness/runner code, not a complete environment image.

This checkpoint does not establish production deployment, isolated clean migration replay, full browser/axe verification, load/retention behavior, successful funded AI calls or completed non-DSA catalogs. See the [full SaaS release gates](./saas-release-gates.md).
