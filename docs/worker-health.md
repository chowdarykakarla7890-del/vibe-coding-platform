# Worker invocation health

The SaaS branch has three authenticated HTTP workers: source capture and sandbox cleanup every minute, and temporary archive/import cleanup every five minutes. `GET /api/internal/worker-health` reports their durable invocation state. It does not run cleanup, refresh the recorded timestamps, or expose customer data.

## Authorization and response

Use the environment's existing `CRON_SECRET` as a Bearer header from a trusted operator service. Missing/invalid authorization returns `401`; missing or weak server configuration returns `503`. Do not put the secret in a URL, browser bundle, screenshot, command history, public status page, or third-party monitor. This secret also authorizes worker execution. A third-party monitoring integration needs separately scoped authorization before receiving access.

All responses are private/no-store and carry `X-Request-Id`. Authorized reads return `200` only when all three workers are healthy; degraded or unavailable health returns `503`. A database/read failure returns the normal structured API error envelope. A valid snapshot returns `status`, database `checkedAt`, and three ordered worker entries containing name, status, last start/finish/success/failure timestamps and the allowed success age. No run identifiers, project IDs, prompts, source, commands, output, or credentials are returned.

| Worker state | Meaning / operator action |
| --- | --- |
| `never-run` | No observed invocation. Check deployment, schedule, secret and database migration. |
| `starting` | First invocation is running; no successful completion yet. |
| `healthy` | A successful completion is recent and no newer observed failure or stuck run exists. |
| `failed` | The latest observed invocation failed, or a new run has not yet recovered the prior failure. Inspect redacted request/job logs. |
| `stuck` | A running invocation has no completion after 90 seconds. Inspect function termination/DB receipts before retrying. |
| `stale` | No success in 3 minutes for minute workers, or 12 minutes for archive cleanup. Check scheduler delivery. |
| `unknown` | Inconsistent timestamps/state. Treat as degraded; do not assume successful cleanup. |

Failure takes precedence over stuck/stale classification. An in-progress retry never clears a previous failure by itself. Database timestamps avoid app-host clock differences. These thresholds allow normal scheduling jitter but are not job-level service-level guarantees.

## Durability, bounds, and failure behavior

Migration `20260828070605_worker_invocation_health.sql` creates a private RLS-enabled table bounded to three rows. Only service-role, security-invoker RPCs can begin/finish/read invocation records; browser roles have neither table access nor function EXECUTE. The public generated TypeScript return fields follow Supabase's function generator, which does not encode output nullability; runtime schema validation handles never-run/null states.

Each authorized worker route awaits a start receipt, runs its normal bounded batch, and records success/failure. A newer start supersedes the prior run identity; stale or duplicate completions cannot overwrite its state. Recent success/failure timestamps survive a new start. This is last-invocation health, not an unbounded event log or a complete history of overlapping batches.

Receipt waits are at most two seconds each. A missing start receipt does **not** suppress the cleanup batch. Unconfirmed health writes are not retried or rolled back: they may have committed after the client stopped waiting. After work, an unconfirmed health receipt produces `503 WORKER_HEALTH_UNAVAILABLE`, explicitly stating that work ran. Actual batch errors retain their existing structured response. Archive purge receipts are bounded to 20 seconds; partial/late completion must not be interpreted as rollback. Health reads are bounded to four seconds, including a transport that ignores abort.

Post-response per-job processing does not refresh these HTTP-invocation records; otherwise it could hide a missing scheduled worker. Structured lifecycle logs contain worker name, request ID, phase, duration and whether the health receipt was confirmed. Provider errors and customer data are never copied into these logs.

## Release and incident checks

1. Replay the migration on the isolated release database, verify generated types, SQL permissions, and database/security advisors. Apply the reviewed migration **before** deploying the instrumented routes.
2. Deploy to the intended environment with its own worker secret. Verify authorization failures and an authorized read. A fresh database should report `never-run`, not fabricated green health.
3. Verify actual scheduled invocations in Vercel logs across multiple schedule intervals, without manual runs masking a missing scheduler. Use a trusted read-only health poll and alert on non-200/timeouts/invalid responses. Vercel cron failure does not provide automatic retry delivery; see [cron management](https://vercel.com/docs/cron-jobs/manage-cron-jobs).
4. Inspect source/cleanup queue age, retry counts, incomplete captures, quota retention and temporary archive/import retention separately. Healthy invocation means a batch completed, **not** that every job finished or that backlog is empty. Empty successful batches are valid liveness evidence.
5. Verify alert delivery to the responsible operator, simulate missed delivery and a failed worker in Preview, and confirm recovery. Do not intentionally break Production workers or write synthetic green records into a customer environment.

The new migration and HTTP reporting are release-branch work, not proof of hosted deployment or active external alerts. Hosted Preview provisioning, scheduled-delivery evidence, backlog monitoring and alert routing remain release gates. Production currently runs the separate local-first recovery hotfix.

## Verification scope

Unit tests cover state/freshness boundaries, fail-closed parsing and authorization, cancellation, receipt deadlines, original-error propagation and redacted logs. Transactional SQL checks cover RLS/grants, invoker privileges, duplicate/stale completions, persisted failure/recovery and bounded worker names. Disposable CI verifies real built HTTP routes against the replayed database, including empty worker batches, concurrent starts/completions and read-only polling. Its fixtures refuse hosted URLs, private environment files or non-empty project/job tables. These checks do not use paid AI or Sandbox services.

See [Supabase function security guidance](https://supabase.com/docs/guides/database/functions#security-definer-vs-invoker) and [release gates](./saas-release-gates.md).
