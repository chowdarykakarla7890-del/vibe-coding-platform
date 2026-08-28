# Authenticated AI release check

Updated 2026-08-27. **The successful eight-model release gate is not passed.**

## Live evidence

`scripts/verify-live-models.mjs` ran against the local Next.js development app,
hosted Supabase, the configured AI Gateway, and one disposable owned Vercel VM.
The check verified the four-primary/four-affordable picker order, anonymous chat
denial, cross-user project/history denial, and unsupported-model rejection.

All eight model requests reached streaming chat but failed before any tool
executed. A minimal independent Gateway request reproduced HTTP **402**; the
SDK wrapped it as `GatewayInternalServerError`. This is service credit
exhaustion, not proof that every model's tool schema is broken. No credits were
purchased and no billing settings were changed. The test's project, VM, and two
temporary users were cleaned up.

After repairing classification, a second live check verified that chat reports
exhausted credits, persists the reserved assistant as `failed` rather than
leaving it `pending`, and preserves the saved source revision. Its disposable
resources were also cleaned up. This failure-path pass is **not** a successful
generation/tool/persistence matrix.

## Repairs

- Gateway HTTP status is classified independently of its misleading error name.
  Credit exhaustion, provider authentication/configuration, model unavailability,
  provider throttling and upstream failure have fixed, redacted guidance.
- HTTP APIs return structured 503/502 service errors, not a learner 401 or a
  misleading request to rewrite the learning goal. Streaming chat uses its
  existing SSE error mechanism because HTTP headers have already been sent.
- Activity assessment retains the submission without assigning a score.
  File-generation tools and error analysis share the same guidance.
- Logs include the request ID, controlled error code and upstream status, never
  provider response bodies, prompts, credentials or file contents.
- The [live Gateway catalog](https://ai-gateway.vercel.sh/v1/models) lists Grok
  4.1 Fast Reasoning as `spacexai/grok-4.1-fast-reasoning`. The public selection
  ID stays `xai/grok-4.1-fast-reasoning` for existing URLs and saved messages;
  the central provider maps it to the current ID. Other model IDs, tier order
  and Claude Opus default remain unchanged. No fallback to a different model
  was introduced. See [Gateway model routing](https://vercel.com/docs/ai-gateway/models-and-providers).

## Reproduce

Use Node 24, the existing ignored `.env.local`, and a local dev server:

```sh
pnpm dev --port 3112
TEST_APP_URL=http://localhost:3112 node --env-file=.env.local scripts/verify-live-models.mjs
```

This deliberately creates two test accounts and one paid ephemeral VM, and
makes eight bounded paid AI requests. Each request must read a newly changed
source value through exactly one owned `readFiles` call, return that current
value, complete streaming and persist matching message parts. The script
rejects non-local app URLs and cleans only its own resources in `finally`.
It refuses to delete ownership records if VM cleanup fails.

While credits are exhausted, verify only the explicit failure path:

```sh
TEST_EXPECT_CREDITS_EXHAUSTED=1 node --env-file=.env.local scripts/verify-live-models.mjs
```

## Remaining release work

Restore Gateway credits or configure an authorized funded credential, then run
the full matrix again. It still must prove all eight models' real streaming,
typed tool calls, multi-turn history and final persistence. The current local
check uses BotID's documented development behavior; deployed BotID, signed-in
browser flows, preview generation, cancellation, and final Vercel preview/
production verification remain separate gates. These changes are not deployed.
