# Project chat lifecycle and recovery

Updated 2026-08-28. This applies to the authenticated SaaS worktree, not the separately deployed local-first recovery hotfix.

## Ownership and lifetime

- The provider retains one SDK `Chat` and one mounted `useChat` controller per opened project. Only the visible workspace children unmount during navigation. Messages keep the existing 50 ms render throttle.
- History reads, transport, sandbox-association refreshes, Stop receipts and recovery reads carry the originating account's cancellation signal. Project deletion or provider disposal aborts that project's session; account replacement aborts the account's outstanding work.
- Tool callbacks for inactive projects cannot update the visible Zustand workspace. A created sandbox is associated/refreshed through the originating project API; its ID is not treated as client authority.
- Visibility changes are not progress. The 90-second watchdog remains active while a project is hidden, even if the next project's history fails to load. Only that project's stream updates reset its deadline.

## Stop and Retry

Stop aborts local streaming immediately. If input preparation has not reached the SDK's submitted state yet, the controller aborts again as that request starts. Before replacing SDK messages, it waits up to ten seconds for the original stream to settle.

When an assistant ID is available, the controller requests server interruption and reads authoritative history. A Stop receipt means the operation was processed, not that it necessarily changed a pending response: completion can win the race. The client must not manufacture `persistenceStatus: interrupted` after either a successful or failed receipt.

The interface displays Stopping or Reconnecting while the corresponding operation is pending. New submissions, duplicate Stop calls and duplicate Retry calls are blocked synchronously, including stale event handlers. An unconfirmed Stop displays explicit recovery guidance and prevents another generation. Retry first reads saved history; it does not blindly repeat the mutation or launch a second paid generation. A still-pending saved response resumes bounded history polling. Failed polling stops until the user retries.

Without an assistant ID, local Stop preserves the user message and marks the local attempt interrupted; it cannot claim a durable server interruption. The server's request cancellation, reservation rules and watchdog remain responsible for any accepted request whose initial response never reached the browser.

## Verification

`tests/project-chat-sessions.test.tsx` uses the real AI SDK `Chat`, `useChat`, transport and SSE parser with controlled network/database doubles. It covers hidden deadlines, progress isolation, simultaneous projects, failed navigation, Stop/finish races, missing receipts, stale handlers, account replacement, deletion, unmount, initial history cancellation, provider failures and explicit retry.

`tests/chat-recovery-ui.test.tsx` covers polite progress announcements, disabled duplicate controls, truthful recovery text, completion removal and empty text/reasoning parts. The existing history-loading, transport, error-monitor, stream-route and tool-output tests remain regression gates.

These are client/controller and component checks, not successful live-provider or database Stop-race evidence. The clean CI browser suite exercises real local authentication/project history, but its existing scenario does not submit a paid generation.

## Remaining release checks

- Verify the complete two-project flow against the actual Preview deployment and funded AI Gateway, including Stop, expiration and account changes.
- Complete project-scoped restoration of terminal commands, preview and workspace state on returning to a background project. Retained chat controllers alone do not prove that full workspace projection is restored.
- Confirm provider cancellation and durable interruption through the real server/database boundary, including a lost initial stream response.
- Hosted Preview isolation, credential rotation, OAuth/email delivery and deployed worker monitoring remain separate release gates.
