# CodeTutor Studio

An AI code tutor where students learn by building inside a real Vercel Sandbox. The tutor breaks projects into milestones, students edit the source in Monaco, run commands and tests in a streaming terminal, preview the result, and request evidence-based code assessments.

## Learning loop

1. Choose a project and experience level.
2. The tutor creates a small scaffold with tests and a bounded first exercise.
3. Explore and edit the live sandbox files in Monaco.
4. Run tests, lint, type-check, builds, or custom commands in the terminal.
5. Ask for a hint, file explanation, or full assessment.
6. Use the terminal for runnable checks. Submit an immutable saved-source copy for server-controlled DSA/code-Challenge grading or clearly labeled AI rubric feedback on other activities.

## Seven learning modes

| Mode | Experience |
| --- | --- |
| Playground | Opens the unrestricted CodeTutor workspace immediately. |
| Practice | 18 guided lessons with explanations, starter code, TODOs, checks, hints, and reflection. |
| Debug | 12 broken implementations focused on diagnosis, targeted repair, and regression evidence. |
| Challenges | Three code contracts in five language tracks (15 entries), plus three React tasks, with submissions and best-score tracking. |
| Projects | Six multi-step blueprints across JavaScript, TypeScript, React, Python, Java, and C++, plus generated projects. |
| DSA | 15 algorithm problems with JavaScript, TypeScript, Python, Java, and C++ templates. |
| Portfolio | A private portfolio builder with project selection, skills, screenshots, GitHub/demo links, preview, and JSON transfer. |

Practice, Debug, Challenges, Projects, and DSA begin in a catalog and then launch the shared tutor/editor/terminal workspace. All 15 DSA problems have task-specific contracts and server-owned behavioral graders in JavaScript, TypeScript, Python, Java and C++. The 15 code-Challenge entries also use server-owned checks and retained grading evidence; the three React Challenges remain AI assessed. The 18 Practice lessons and 12 Debug exercises have specific contracts, runnable visible checks, progressive hints and reflection prompts; open **Instructions** in the activity header or `LESSON.md` in the editor. Debug starters contain reproducible behavioral bugs, with a `DIAGNOSIS.md` for root cause and regression evidence. Practice and Debug submissions still receive clearly labeled AI rubric assessment: editable learner checks are not trusted scoring evidence. The six Project blueprints now have concrete domain/browser/CLI workflows, four milestones each, runnable checks and reflection files. Project submissions remain AI assessed; learner milestone checklists do not award verified completion. See [Practice lessons](docs/practice-lessons.md), [Debug exercises](docs/debug-lessons.md), [Challenge contracts and verification limits](docs/challenges.md) [Project blueprints](docs/project-blueprints.md) and [trusted grading](docs/trusted-grading.md); this implementation is not yet deployed.

## Device-local data

The current SaaS worktree stores projects, source snapshots, activity attempts, progress, chat history, generated manifests, and portfolio data through authenticated Supabase APIs. IndexedDB is an account-scoped cache. Legacy device-only work remains on the original device until explicitly exported/imported; do not clear site data to repair an application error.

The in-progress SaaS foundation protects workspace pages with Supabase sign-in and separates local caches by account. Existing pre-sign-in device data is preserved, but is not automatically imported into an account. Hosted two-user integration tests cover cloud history and source isolation. The migration is **not production-ready or deployed**; see [release gates](docs/saas-release-gates.md) before deploying this worktree.

Source snapshots intentionally exclude dependency folders, build output, caches, binaries, files over 256 KB, projects over 200 files, and snapshots over 10 MB. When a sandbox expires, the UI can create a replacement sandbox and restore the saved source snapshot.

Manual coding does not require an AI response: choose **Create file or folder → Create blank workspace**, save your files, run a web server in terminal **Server** mode on port 3000, and open **Preview**. Its read-only URL is verified against your owned sandbox. After restoring an expired sandbox, restart the web server. See [owned previews and verification limits](docs/owned-preview.md); these SaaS changes are not deployed yet.

**Automatic diagnostics** sends likely command failures—not ordinary server access logs—to the AI tutor using your AI quota. Failed checks pause for explicit retry and cancel when their workspace becomes obsolete. See [diagnostic behavior, limits and verification](docs/automatic-diagnostics.md).

**Custom activities** are validated and saved to your account. Generation has bounded requests and can be cancelled without navigating on a late response. Cancellation cannot undo provider usage or a save already sent; use **Reload saved activities** before trying again. See [generation and recovery limits](docs/custom-activity-generation.md).

**Import source** stages and verifies a source-only JSON export before atomically creating a new, ungraded Playground project. Interrupted uploads can resume with the same export file; cancellation never deletes a published project. Existing drafts are preserved until you explicitly choose to switch. Chat history, scores, activity links and sandbox credentials are not imported by this source-only action. See [source import behavior and limits](docs/source-imports.md).

**Import archive** recovers version-2 and version-3 NDJSON archives: current saved source becomes a new Playground project and every original history record is retained as read-only, unverified evidence in **Imported history**. New full exports combine current saved work and earlier imported history in one file, including repeated recovery cycles. Historical files never overwrite the current source; imported tools do not run and archived scores do not count toward verified progress. Unsaved drafts and uncaptured VM changes are excluded. Explicit legacy-device migration, signed-in visual verification and deployment remain unfinished. See [full archive recovery](docs/archive-imports.md).

The workspace's **Review source** control shows pending/incomplete command captures and preserved source conflicts. Compare saved and terminal versions, keep either one, merge manually, or download both reviewed copies. Resolution checks the exact reviewed revision and retains the original copies. It updates saved source only—not a running sandbox—and displays restoration guidance until a replacement sandbox is created. Automatic capture scheduling and safe live-sandbox synchronization still need release verification; see [source consistency](docs/source-consistency.md).

**Submission history** retains the exact saved source, file revisions, activity instructions, model, and feedback for each attempt. Later edits and sandbox expiration do not change those submitted files. Evidence storage is capped at 50 MiB per project and 200 MiB per account, including repeated activity metadata; identical source copies are deduplicated. The current AI reviewer accepts at most 64,000 UTF-8 bytes of complete JSON source evidence, and oversized submissions are retained without a score. See [submission history and limits](docs/submission-history.md).

## Core stack

- Next.js 16 and React 19
- AI SDK 6 with Vercel AI Gateway
- Vercel Sandbox for isolated files, commands, and previews
- AI Elements conversation and suggestion patterns
- Monaco Editor for student-authored code
- Tailwind CSS and shadcn/ui

See [the AI Elements audit](docs/ai-elements-audit.md) for the component map and extension plan.
See the [product and technical specification](docs/product-spec.md) for the complete product overview, architecture, workflows, roadmap, and security considerations.

## Supported models

### Primary models

| Model | AI Gateway ID | Recommended use |
| --- | --- | --- |
| Claude Opus 4.6 | `anthropic/claude-opus-4.6` | Complex tutoring, architecture, and multi-step implementation |
| Claude Sonnet 4.6 | `anthropic/claude-sonnet-4.6` | Balanced tutoring, coding, and review |
| GPT-5.3 Codex | `openai/gpt-5.3-codex` | Deep coding tasks with configurable reasoning effort |
| Grok 4.1 Reasoning | `spacexai/grok-4.1-fast-reasoning` | Fast reasoning and problem solving |

### Affordable models

| Model | AI Gateway ID | Recommended use |
| --- | --- | --- |
| DeepSeek V4 Flash | `deepseek/deepseek-v4-flash` | Low-cost instruction following and lightweight agent tasks |
| GPT-5 nano | `openai/gpt-5-nano` | Fast suggestions, classification, and simple tutor questions |
| Gemini 3.1 Flash Lite | `google/gemini-3.1-flash-lite` | High-volume code completion, review, and long-context work |
| Devstral Small 2 | `mistral/devstral-small-2` | Cost-efficient coding, repository exploration, and debugging |

Model availability and pricing can change. Check the [Vercel AI Gateway model catalog](https://vercel.com/ai-gateway/models) for current details.

Existing Grok selections and `?modelId=xai/grok-4.1-fast-reasoning` links remain supported. CodeTutor maps that stable selection ID to the current `spacexai/` Gateway ID internally; it does not switch to a different model.

## Run locally

Use Node `24.18.0` (see `.node-version`) and pnpm `11.19.0` (see `packageManager`). For a new checkout, create `.env.local` using `.env.example` as a template; preserve any existing values:

```bash
AI_GATEWAY_API_KEY=your_key_here
VERCEL_AUTH_TOKEN=your_vercel_token
VERCEL_TEAM_ID=your_team_id
VERCEL_PROJECT_ID=your_project_id
NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your_publishable_key
SUPABASE_SECRET_KEY=your_server_only_secret_key
NEXT_PUBLIC_APP_URL=http://localhost:3010
```

Install and start:

```bash
pnpm install --frozen-lockfile
pnpm dev --port 3010
```

Open [http://localhost:3010](http://localhost:3010). Configure the matching `/auth/callback` URL in Supabase Auth. The secret key is server-only and must never use a `NEXT_PUBLIC_` prefix.

Run `node --env-file=.env.local scripts/check-auth-service.mjs` to inspect enabled sign-in methods without sending email or starting OAuth. See [authentication readiness](docs/authentication-readiness.md) for Google setup, callback configuration and remaining delivery checks; provider flags alone do not prove sign-in works.

## Quality checks

The filesystem-safety tests require Python 3.11+ as well as the pinned Node/pnpm versions. The Practice, Debug, Challenge and Project execution tests also require Java 21 (`javac` and `java`) and a C++17 compiler (`g++`). If `python3` points to an older system runtime, set `CODETUTOR_TEST_PYTHON` to your Python 3.11+ executable before running tests. Production grading uses the Sandbox's Linux runtime, not your workstation's Python.

```bash
node scripts/check-toolchain.mjs
pnpm lint
pnpm exec next typegen
pnpm type-check
pnpm test
pnpm audit --prod --audit-level=high
pnpm build
```

The checks-only GitHub workflow adds clean installation, isolated database replay, RLS/API checks and production HTTP smoke tests. See [CI verification and activation](docs/continuous-integration.md); the workflow is not yet activated on GitHub and does not deploy the application.

Supabase configuration and sign-in are required to open the workspace. The AI key and Vercel Sandbox access are additionally required for live tutor projects.

Before deployment, read [environment configuration and preflight checks](docs/deployment-environments.md). Vercel builds now reject missing service settings, public server-key exposure, and Preview connections to the production database. The isolated Preview database has not yet been provisioned; configuring secrets is not release approval.
