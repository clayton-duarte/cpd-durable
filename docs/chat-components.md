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

### Current embedding contract

`src/client/chat.tsx` exports `Chat` and `ChatProps`. Supply a title, optional description, validated presentation state (`null` while loading), connection status and optional pending/error state. The parent must provide a bounded height; `Chat` fills that space rather than taking over the viewport.

Omit `onSend` for read-only presentation. Otherwise it returns `true` only when admission is confirmed, not when the answer completes. Acknowledgement clears only the unchanged submitted draft. `onStop` is optional and is offered only during active work.

After uncertain delivery, the host can supply `retryText` with an error. Retry submits that original text through `onSend`; the transport must retain its original request ID. Ordinary sends are disabled until that uncertainty is resolved, but editing a new draft remains possible. This retry identity is currently transient and does not survive refresh. `src/client/chat-page.tsx` is the application-specific integration; `src/client/use-chat.ts` owns the current single-conversation API connection.
