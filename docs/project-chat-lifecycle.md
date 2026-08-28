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

Stop additionally requires the generation's UUID `requestId`, supplied by stream metadata and owner-authorized saved history. The database update matches project, account, message ID, generation ID, assistant role and pending status together. Retry reuses an assistant row but changes its request ID, so an old Stop cannot affect the newer attempt. Legacy messages without that identity remain readable; the client must reconnect before attempting Stop. The mutation receipt is bounded to ten seconds server-side and twenty seconds client-side; a missing receipt does not imply rollback.

The interface displays Stopping or Reconnecting while the corresponding operation is pending. New submissions, duplicate Stop calls and duplicate Retry calls are blocked synchronously, including stale event handlers. An unconfirmed Stop displays explicit recovery guidance and prevents another generation. Retry first reads saved history; it does not blindly repeat the mutation or launch a second paid generation. A still-pending saved response resumes bounded history polling. Failed polling stops until the user retries.

Without an assistant ID, local Stop preserves the user message and marks the local attempt interrupted; it cannot claim a durable server interruption. The server's request cancellation, reservation rules and watchdog remain responsible for any accepted request whose initial response never reached the browser.

## Verification

`tests/project-chat-sessions.test.tsx` uses the real AI SDK `Chat`, `useChat`, transport and SSE parser with controlled network/database doubles. It covers hidden deadlines, progress isolation, simultaneous projects, failed navigation, Stop/finish races, missing receipts, stale handlers, account replacement, deletion, unmount, initial history cancellation, provider failures and explicit retry.

`tests/chat-recovery-ui.test.tsx` covers polite progress announcements, disabled duplicate controls, truthful recovery text, completion removal and empty text/reasoning parts. The existing history-loading, transport, error-monitor, stream-route and tool-output tests remain regression gates.

`tests/chat-stop-route.test.ts` covers generation-fenced filters, validation, ownership failure, redacted failures and bounded/cancelled database waits. The disposable-database HTTP suite also checks interruption, Retry reusing the row with a new request ID, late old Stop leaving the new pending generation untouched, and completed-response preservation. CI must pass these actual database assertions before this checkpoint is accepted. The clean CI browser suite exercises real local authentication/project history, but its existing scenario does not submit a paid generation.

## Project-scoped workspace projection

The account-lifetime registry now retains a separate workspace projection for each opened project. It includes the current sandbox identity/status, file paths and selection, source-update revision signal, terminal commands/output/cursors, edit count and Code/Preview selection. Only the active projection is exposed through the existing UI store. The registry copies data, never store action functions; editor/terminal actions still target the visible workspace.

Live tool parts update the originating project's projection even when it is hidden. Returning to it restores that projection before the workspace is painted. Saved assistant command/preview parts are reconciled only for the current VM; old creation/file events are not replayed into authoritative saved source. This reconciliation is skipped during live streaming, which already receives `onData`, to avoid scanning all history on each token.

Log subscribers remain visibility-scoped: leaving a project aborts its reader, returning resumes from the retained byte cursor, and completed output is not subscribed again. A command completed while hidden is discovered and drained on return. Already received output remains visible after expiration, but output not retrieved before the VM expires may be unavailable. This in-memory projection is not a durable terminal-output archive: a hard reload can reconstruct saved assistant command metadata, but not unsaved manual terminal history or its received output.

New preview tool parts include `sandboxId`; legacy parts without it remain readable in chat but cannot set the workspace preview. Old/foreign/retired VM events are ignored. The preview component still obtains its actual iframe URL through the owner-validated preview endpoint. Replacing a VM resets its execution projection; a duplicate creation event or late project receipt cannot revive a stopped/retired VM. Source hydration respects a streamed replacement while its project receipt is still refreshing.

Account cancellation, deletion and provider disposal remove the relevant projections and reject late callbacks. Activity startup also checks the activated workspace identity, closing the interval before old passive effects finish cleaning up. The existing unsaved-editor confirmation rules remain in place; restoring a selected file is not a claim that discarded draft text is saved by this registry.

`tests/project-chat-sessions.test.tsx` reproduces and verifies the missing background files/commands/preview and cross-project terminal display. `tests/project-workspace-registry.test.ts` covers isolation, replacement, replay, account/deletion cleanup and stale progress. `tests/project-terminal-restoration.test.tsx` exercises the actual log subscriber through switches, cursor resumption and completion. File explorer, workbench, source hydration and activity-startup tests cover their corresponding remount/race behavior. Hosted two-project generation and preview rendering remain live release gates, not proven by these component tests.

## Remaining release checks

- Verify the complete two-project flow against the actual Preview deployment and funded AI Gateway, including Stop, expiration and account changes.
- Verify project-scoped terminal/preview restoration against an actual hosted generation and owned VM, including expiration before logs are retrieved. Component tests do not prove the provider/VM boundary.
- Confirm provider cancellation and durable interruption through the real server/database boundary, including a lost initial stream response.
- Hosted Preview isolation, credential rotation, OAuth/email delivery and deployed worker monitoring remain separate release gates.
