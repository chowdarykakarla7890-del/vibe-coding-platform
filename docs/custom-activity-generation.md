# Custom activity generation: cancellation and recovery

Local stabilization checkpoint, 2026-08-28. These changes are part of the unfinished authenticated SaaS worktree and are **not deployed**.

## Confirmed defects and repair

Component regression tests reproduced two failures before the fix: the dialog's **Cancel** button hid it without aborting the request, and an account change during a delayed response body still opened the old account's activity.

All dialog dismissal paths now cancel the request. Project/mode changes and unmount also cancel it; the complete receipt is bound to the originating cloud account. A late response cannot navigate, acknowledge old work, or clear a newer request's loading state. Repeated form submissions are deduplicated while pending. Goals are retained after failures, and progress/error messages are accessible in the dialog.

The dialog now correctly describes account storage rather than device-only caching. Generation consumes the account's AI quota. The catalog offers **Reload saved activities** after cancellation or failure, instead of automatically sending another paid request.

## Boundaries

- `/api/activities/generate` keeps its request and successful response shapes. A shared strict request schema trims and validates the goal/language, mode and difficulty; unknown models remain rejected. The eight-model registry and default model are unchanged.
- The server bounds the complete operation to 120 seconds, including authentication, bot verification, quota checks, generation and the storage receipt. It checks cancellation before subsequent work, disables provider retries and caps generated output at 16,384 tokens. The existing database insert retains its own timeout. No database schema or ownership policy changed.
- BotID now has matching client initialization and server checks on this route, before quota consumption and AI calls. Authentication, same-origin checks and account quotas remain required; BotID is not a replacement for authorization.
- Server-generated IDs and the requested mode/difficulty cannot be replaced by model output. Existing path, size, rubric and command validation remain mandatory; unsafe verification commands become rubric-only and unsafe setup commands are rejected.
- The client bounds headers **and** the response body to 130 seconds, including transports that ignore abort signals. It validates the returned activity's generated identity and mode before navigating.
- Interruption returns a structured `408 GENERATION_INTERRUPTED`; invalid manifests return `502 INVALID_ACTIVITY`. Storage/provider failures retain structured service errors and are no longer mislabeled as bad learner input. Request IDs and lifecycle durations are logged without goals or source code.

Cancellation is not a rollback or a refund. A provider request or database write already dispatched can finish after the browser stops waiting. The UI therefore asks the learner to check saved activities before generating again. No automatic retry, duplicate write or compensating deletion is performed.

The repair reuses the account-aware request and mutation-receipt helpers, applying the networking/React guidance to cancellation and primitive effect dependencies. AI SDK options and BotID initialization were checked against the installed SDK documentation; see the [AI SDK reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/generate-text) and [BotID setup](https://vercel.com/docs/botid/get-started).

## Verification

- Forty-six focused client, route, credit-error and BotID tests pass. These cover Cancel/Escape, unmount, account/project/mode changes, late bodies, rapid submissions, replacement requests, malformed manifests, quota errors, stalled authentication/bot/quota/provider/storage stages, no late storage dispatch and redacted lifecycle output.
- The full local suite passes **1,749 tests**, with 17 live opt-ins skipped, across 118 passing files. Lint, TypeScript, Node 24 production build, whitespace checks and the production dependency audit pass.
- After repairing its fixture lifecycle, the full two-user hosted database/API test passes, including generation requests rejected before BotID, quota consumption or AI, generated-activity ownership/pagination, private assessment history, source recovery, immutable submissions, atomic reservations, cross-user denial and cascade deletion. Both temporary users were removed; their never-launched cleanup records are retained as completed/not-started metadata. This does not prove successful provider generation.

The hosted test exposed stale assumptions in its database-only fixtures: synthetic sandbox rows leave durable cleanup tombstones after project deletion, and those correctly retain quota until settled. A later teardown also raced with the real deletion endpoint's after-response cleanup worker. The runner now marks only its own validated, never-launched handles `complete/not_started` before scheduling deletion, preserving production quota/lease logic. It refuses unknown handles and active worker leases; it does not alter unrelated cleanup jobs. Synthetic records from the failed attempts were resolved explicitly, without stopping or creating any VM.

## Remaining release gates

Successful model-generated activity → saved manifest → browser workspace launch remains a live provider test, as does deployed BotID verification. Mocked responses and authenticated rejection tests do not prove either. No AI generation, VM creation, deployment, credential rotation or migration was performed for this checkpoint. The broader [SaaS release gates](./saas-release-gates.md), including isolated CI/database replay and deployment authorization, remain open.
