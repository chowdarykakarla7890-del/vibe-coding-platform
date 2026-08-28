# Durable sandbox cleanup

Updated 2026-08-28. This is a cleanup checkpoint, not production release approval.

## Confirmed defect and repair

A failed startup marked its reservation failed even when the initial provider Stop failed. This released its quota and could strand a paid VM. Deleting a project also lost pending-creation handles when `sandbox_id` had not been acknowledged.

Migration `20260827200351_durable_sandbox_cleanup.sql` installs a private cleanup job before any provider creation request. Its deterministic name is `codetutor-<reservation UUID>`. The database records successful attachment; abandoned startup is eligible after three minutes. Failed startup and project/account deletion enqueue cleanup atomically with the corresponding database mutation. Operational jobs intentionally have no cascading foreign keys, so deletion cannot erase the last handle.

Quota checks count unfinished cleanup jobs as well as active sessions, deduplicated by reservation ID. A pending job therefore still occupies the project's slot and one of the account's two slots. This trades temporary availability for avoiding unbounded unconfirmed resources.

## Worker guarantees and limits

- Claims use row locks, `SKIP LOCKED`, a random lease token and a 40-second lease. Expired workers cannot finalize a newer lease or attach a sandbox after cleanup claims its startup.
- The worker looks up only database-owned names, with `resume: false`. It never wakes a stopped VM to clean it up.
- Confirmed stopped receipts complete a job. Early missing/failed/aborted/no-current-session observations remain pending through a conservative observation window: at least 50 minutes from reservation and three minutes past the recorded expiration. One immediate 404 is not treated as proof that a delayed creation cannot appear.
- Retry backoff is 30 seconds up to five minutes. Each provider/claim operation has a shared 25-second deadline; settlement has its own five-second deadline. Batches process at most ten jobs with two concurrent workers and a 45-second batch deadline.
- `after()` attempts delivery after the original HTTP response. This is opportunistic; persistent records and the scheduled worker own crash recovery. A successful project deletion acknowledges deletion and scheduled cleanup, **not synchronous VM shutdown**.
- `GET /api/internal/sandbox-cleanup` requires the server-only cron secret. Its configured minute schedule is checked in but **not deployed or verified on Vercel**. Request-time delivery alone is not a production scheduler.
- This queue is for failed startup and destructive deletion. Normal Stop still uses the separate source-preserving shutdown/capture workflow. Cleanup does not snapshot unsaved source or promise restoration of unsaved terminal changes.
- A bounded observation window is not an absolute guarantee against arbitrarily delayed provider creation. Finite ephemeral VM lifetimes remain a fallback. Tombstone retention, deployed backlog monitoring and clean-database migration replay remain release work.

## Security

The queue stores operational identifiers, lease/timing state and fixed result codes only; no credentials, source, prompts, command output or client-provided provider handles. RLS is enabled and all browser-role table/RPC grants are revoked. Claims and settlements are service-role-only. The cascade trigger uses a private function with an empty search path and no public execution grant.

The Supabase advisor's informational [RLS enabled with no policy](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy) notice for this table is intentional default-deny protection. Do not add public policies to silence it. The pre-existing [leaked-password-protection warning](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection) remains a separate release gate.

## Reproducible verification

Normal unit tests include worker deadlines, provider failures, stale settlement, no-resume lookup, batch limits, post-response failures, route authentication/ownership/CSRF and startup cancellation.

The final local regression run passes 1,011 tests (ten opt-in live tests skipped by default), lint, TypeScript and diff checks. The Node 24 production build passes, and the production dependency audit reports no known vulnerabilities. The cleanup live test below was run separately and passed.

Hosted database protocol check (two disposable users, synthetic names, no VMs/AI/email):

```sh
RUN_SANDBOX_CLEANUP_CHECK=1 node --env-file=.env.local scripts/verify-sandbox-cleanup.mjs
```

This passes retained project/account quotas, private grants, concurrent claims, stale/crashed leases, missing-resource observation, healthy-attachment exclusion, late-attachment fencing, and project/account deletion survival. Disposable users and synthetic jobs are removed afterward.

Live integration check against a freshly rebuilt **local** app on port 3112:

```sh
RUN_LIVE_SANDBOX_CLEANUP=1 TEST_APP_URL=http://127.0.0.1:3112 \
  node --env-file=.env.local node_modules/vitest/vitest.mjs \
  run tests/live-sandbox-cleanup.test.ts --maxWorkers=1
```

This explicitly creates two disposable accounts and two sequential short-lived paid VMs. It checks owner-authorized deletion through the real HTTP route, actual Next post-response delivery, and deterministic-name recovery when the creation receipt is missing. It stops the test VMs, signs out and deletes the temporary accounts in cleanup; incomplete jobs remain durable if a provider failure prevents confirmation. No AI or customer project is used.

The live check passed on 2026-08-28 against the rebuilt Node 24 local production server, hosted Supabase and real Vercel Sandbox. Both VM shutdowns were confirmed; temporary accounts were signed out and removed. This does not verify deployed cron delivery or repair the older public deployment.
