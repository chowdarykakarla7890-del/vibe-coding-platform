# AI Elements audit for CodeTutor Studio

AI Elements provides the presentation primitives around an AI interaction. Monaco and the Vercel Sandbox remain the execution layer because AI Elements does not replace a writable IDE or shell.

## Used in the tutor

| Element | Tutor use |
| --- | --- |
| Conversation | Scrollable, streaming mentor conversation in `app/chat.tsx` |
| Loader | Streaming activity feedback while the mentor works |
| Suggestions | Project/lesson starters on the empty tutor screen |
| Tool activity pattern | Visible sandbox creation, file generation, commands, previews, and code-reading activity |
| File tree pattern | Navigation for the student's live sandbox files |
| Terminal pattern | Streaming command output plus a student command input |

The file tree and terminal are sandbox-aware adaptations rather than registry copies. They need write APIs, command IDs, streamed logs, and lesson progress state that the generic presentational components do not own.

## Strong next additions

| AI Element | Best use in this product |
| --- | --- |
| Plan | Render the tutor's generated milestone plan inside chat |
| Task | Expandable exercises with files, completion state, and expected checks |
| Checkpoint | Mark saved attempts and assessment moments in the lesson timeline |
| Test Results | Structured display for the exact test command and pass/fail cases |
| Code Block | Mentor examples and diffs; Monaco remains the editable source of truth |
| Snippet | One-click commands for the student terminal |
| Stack Trace | Focused debugging explanations linked to files and lines |
| Sources / Inline Citation | Cite documentation used in concept explanations |
| Tool | Standardize read-files, test, lint, build, and preview activity cards |
| Confirmation | Ask before the tutor replaces student-authored code |
| Artifact / Panel | Package lesson notes, rubric reports, and project requirements |
| Web Preview | A reusable wrapper around the sandbox preview iframe |
| Package Info | Teach dependencies when they are introduced |
| Schema Display | API, database, and validation lessons |

## Available but secondary

Attachments, Image, Audio Player, Speech Input, Transcription, Mic Selector, Voice Selector, Persona, Model Selector, Queue, Context, Reasoning, Chain of Thought, Agent, Controls, Toolbar, Canvas, Node, Edge, Connection, Commit, Sandbox, Environment Variables, Open in Chat, JSX Preview, and Shimmer are useful for later multimodal lessons, visual agent workflows, or richer project inspection. They are not prerequisites for the first complete learn-edit-test-assess loop.

## Editor decision

`@monaco-editor/react` is intentionally used for the student's editor. It supplies language services, keyboard editing, and a familiar IDE surface. Saving writes the current buffer to Vercel Sandbox through `PUT /api/sandboxes/:sandboxId/files`; AI review then reads that saved source through the `readFiles` tool. This ensures assessments are based on the student's actual code rather than stale chat history.
