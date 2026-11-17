# Chat capability mapping

Accepted direction (2026-11-17), not a claim that every capability is implemented. The [SDK inventory](pi-durable-features.md) scopes this mapping to pi-durable 1.5.2. Use only stock [shadcn components](https://ui.shadcn.com/docs/components), composed without custom visual primitives or a custom theme.

## Vocabulary and containment

- **Message** represents participant content; **Trace** represents agent activity; **Marker** represents events and boundaries.
- Preserve chronological content order, including text interleaved with activity. Do not manufacture reasoning, progress, citations or metadata.
- Use Popover and Sheet for optional detail, not a permanently expanded developer console.
- The embedding application owns routes, placement, dimensions, conversation selection and transport/provider integration.
- Each mounted chat owns its draft, scroll position and expanded details. Change its React key when switching conversations. Multiple views are independent, not synchronized draft editors.
- Actions must follow actual capabilities and authority. Read-only views must not need mutation controls.
- Credentials, storage configuration, registry administration and telemetry infrastructure remain outside chat.

## 1. Conversation and messages

| Capability                      | Stock components                       | Presentation                                                       |
| ------------------------------- | -------------------------------------- | ------------------------------------------------------------------ |
| Transcript                      | Message Scroller, Message              | Preserve position during streaming and history prepends            |
| User/assistant content          | Message, Bubble                        | Participant alignment; preserve whitespace                         |
| Sender/metadata                 | Message header/footer; optional Avatar | Relevant supplied identity, not invented timestamps                |
| Streaming                       | Message content                        | Update one row, not one per token                                  |
| Initial loading                 | Skeleton                               | History not yet available                                          |
| Empty conversation              | Empty                                  | Starting state, distinct from loading                              |
| Earlier history                 | Button, Spinner                        | Load earlier at the top                                            |
| Missing segment after reconnect | Marker, Button                         | Explicit gap and recovery action                                   |
| Submission acknowledgement      | Message footer, Spinner                | Sending/admitted/failed; admission is not answer completion        |
| Safe resend                     | Message footer, Button                 | Retain original request identity after ambiguous delivery          |
| Interrupted answer              | Message footer, Badge                  | Retain partial content and label interruption                      |
| Custom transcript entries       | Marker or Message                      | Event versus participant content, with an explicit safe projection |
| Code snippets                   | Code Block                             | Snippet formatting, copy and wrapping                              |
| Structured results              | Table or Code Block                    | Table only for meaningful tabular data                             |
| Images                          | Attachment, Dialog                     | Requires real provider/input support                               |
| Files/downloads                 | Attachment                             | Requires host-managed access                                       |
| Supplied sources                | Trace links                            | Only references actually returned by tools                         |

Full Markdown remains unresolved: Message is layout and Code Block is not a Markdown parser. Plain text remains the safe default; no outside parser is implicitly approved.

## 2. Composer and run controls

| Capability             | Stock components              | Presentation                                            |
| ---------------------- | ----------------------------- | ------------------------------------------------------- |
| Text input/send        | Input Group, Textarea, Button | Multiline draft                                         |
| Stop/continue          | Button                        | Only when applicable; distinct operations               |
| Follow-up versus steer | Dropdown Menu                 | Explicit send modes; distinguish requested from applied |
| Queue                  | Collapsible, Item, Badge      | Pending inputs above composer, not delivered messages   |
| Withdraw queued input  | Button                        | Specific input, not abort entire run                    |
| Reset context          | Dropdown Menu, Alert Dialog   | Explain that stored history remains                     |
| Handoff instructions   | Dialog, Field, Textarea       | Optional instructions and explicit confirmation         |
| Selected attachments   | Button, Attachment group      | Removal and real processing/error state                 |

## 3. Agent activity, tools and tasks

| Capability                   | Stock components             | Presentation                                                      |
| ---------------------------- | ---------------------------- | ----------------------------------------------------------------- |
| Provider-supplied reasoning  | Trace collapsible row        | Only available content                                            |
| Tool call/status             | Trace                        | Name, actual state and supplied duration                          |
| Arguments/results            | Code Block, optional Tabs    | Input/output detail                                               |
| Streamed output/errors       | Trace, Code Block            | Bounded output; sanitized failure, not color alone                |
| Nested tools/code mode       | Nested Trace, Code Block     | Actual parent-child order and script                              |
| Deferred-tool search/loading | Trace                        | Activity rather than permanent panel                              |
| Foreground subagent          | Trace, Badge, Button         | Assignment, status, result, open conversation                     |
| Background subagent          | Trace, Badge                 | Explicit background scope; parent Stop is not global cancellation |
| Dependencies/child tasks     | Nested Trace                 | Actual waits and relationships, no required graphical DAG         |
| Sleep/deferred response      | Trace, Badge                 | Known wake time, no invented percentage                           |
| After-run work               | Trace, Marker                | Answer completion versus continuing follow-up work                |
| Task inspection              | Sheet, Trace, optional Table | Conversation-scoped detail                                        |

## 4. Context, configuration and usage

| Capability               | Stock components                | Presentation                                                                |
| ------------------------ | ------------------------------- | --------------------------------------------------------------------------- |
| Model/provider identity  | Badge, Popover                  | Compact header identity                                                     |
| Model/thinking selection | Combobox, Select                | Only enabled models and supported levels                                    |
| Instructions             | Dialog, Field, Textarea         | Explicit configuration action                                               |
| Tools/extensions         | Sheet, Item, Checkbox/Switch    | Effective configuration; changes need host authority                        |
| Environment/directory    | Badge, Popover/Sheet            | Selection and permissions belong to host                                    |
| Tool-round limit         | Field, Input                    | Call it tool rounds, not response length                                    |
| Tokens/cost              | Popover, Table                  | Input/output/cache/model breakdown                                          |
| Context-window usage     | Progress, Popover               | Meaningful measured or labelled estimated denominator; not cumulative usage |
| Active model context     | Sheet, Tabs, Message/Code Block | Separate from full stored history                                           |
| Automatic compaction     | Marker, Spinner                 | Event, not participant message                                              |
| Completed summary        | Marker, Collapsible             | Optional summary detail                                                     |
| Manual compaction        | Dropdown Menu, Dialog, Textarea | Explicit action and optional instructions                                   |
| Compaction failure       | Alert, applicable Button        | Persistent recovery, not toast-only                                         |

## 5. Recovery and connection

| Capability              | Stock components         | Presentation                                                |
| ----------------------- | ------------------------ | ----------------------------------------------------------- |
| Connecting/reconnecting | Badge/Marker, Spinner    | Keep visible history and draft                              |
| Resumed work            | Marker, Trace            | No duplicate user message                                   |
| Retry/backoff           | Trace/Marker             | Known timing only                                           |
| Run failure             | Alert, applicable Button | Only valid recovery actions                                 |
| Storage/host failure    | Alert                    | Honest unavailable/read-only state                          |
| Read-only conversation  | Badge, optional Alert    | No mutation controls                                        |
| Diagnostics             | Sheet, Code Block        | Authorized sanitized projection, never raw secrets/payloads |
| Custom document state   | Sheet, Table/Code Block  | Selected useful projection, not arbitrary SDK dump          |

Disconnect, cancellation, failure and success remain distinct states.

## 6. Adjacent host integrations

| Capability             | Stock components                     | Boundary                                                |
| ---------------------- | ------------------------------------ | ------------------------------------------------------- |
| Approvals              | Alert, Button, optional Alert Dialog | Hooks can block; durable approval protocol is host work |
| Structured questions   | Questionnaire                        | Durable answer delivery/resumption is host work         |
| Proposed file changes  | Trace, Code Block diff, Sheet        | Requires actual tool/host evidence                      |
| Fork/open conversation | Dropdown Menu/Button                 | Host owns navigation                                    |

Creating a conversation and resetting current model context are separate actions.

## Delivery status

Implementation proceeds section by section. The first Section 1 increment separates the application page/transport from reusable presentation, adds initial loading/empty states, sender/interruption metadata and explicit ambiguous-delivery retry. Existing text streaming, whitespace and unchanged-draft acknowledgement behavior are retained.

Still pending in Section 1: history paging, gap recovery, stable live-to-committed row identity, ordered rich-content projection and a safe custom-entry projection. Code, structured data, attachments and sources are not claimed as implemented. No tools, additional models, uploads or host approval/question protocols are enabled by this mapping.

Section 2 now exposes multiline input, explicit Send now/follow-up/steer modes, Stop, context-aware Continue, a collapsible queued-input list with per-item withdrawal, and confirmed model-context reset with optional handoff instructions. These are backed by actual SDK admission/inbox/context state; selected attachments remain deferred with the text-only host.

Steering is requested for an eligible boundary, not an immediate interruption. An idle steering submission is rejected rather than silently starting another run. Follow-ups can be admitted while idle or busy. Queued inputs are separate from transcript messages until placed. Withdrawal can lose a placement race; the UI reports `already_placed` rather than claiming removal. Stop aborts current foreground work and withdraws queued inputs; it does not withdraw queued resets (SDK write submissions).

Continue eligibility is derived server-side from idle active context ending in user content or tool results, with no queued reset, not from the recent transcript window or failure label. It adds no user message. Reset retains stored history, runs at the next boundary if busy and may place queued inputs into the new context. Handoff text becomes a user message; a reset by itself does not request an answer. Continue and reset admissions retain request IDs for safe retry, using the SDK's public reset-entry shape for the latter.

### Current embedding contract

`src/client/chat.tsx` exports `Chat` and `ChatProps`. Supply a title, optional description, validated presentation state (`null` while loading), connection status and optional pending/error state. The parent must provide a bounded height; `Chat` fills that space rather than taking over the viewport.

Omit `onSend` for read-only presentation. Otherwise it receives text and an optional send mode and returns `true` only when admission is confirmed, not when the answer completes. Acknowledgement clears only the unchanged submitted draft. `onStop`, `onContinue`, `onReset` and `onWithdraw` are optional, capability-gated callbacks. The optional `state.controls` projection provides Continue eligibility, queued inputs and pending-reset state; without it, advanced controls stay hidden.

After uncertain delivery, the host supplies `uncertain`, an error and `onRetry`, with `retryText` for input or `retryAction` for a control. Retry must retain the original operation, payload and request ID; changing a send mode must not change the uncertain action. Mutation controls are disabled until uncertainty resolves, but editing a new draft remains possible. Continue/reset/withdraw do not consume the composer draft. Reset handoff text is retained after a failed attempt; a retry confirms the original admitted action, not newly edited instructions.

The current transport serializes mutations, distinguishes definite rejection from uncertain delivery and preserves retry identity only until refresh. After an uncertain action followed by refresh, inspect the restored state before repeating it. `src/client/chat-page.tsx` owns application integration; `src/client/use-chat.ts` owns the single-conversation API connection. `src/client/chat-composer.tsx` contains the instance-local composer mode, queue expansion and reset confirmation/handoff state.

Stop is not a request-ID admission: a later abort could target newer work. An uncertain Stop therefore asks the user to inspect current state before explicitly stopping again, rather than offering a supposedly safe original-action retry.
