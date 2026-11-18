# Chat capability mapping

Settled direction, updated 2026-11-17: **assistant-ui > shadcn; no custom visual components**. Use supplied assistant-ui elements throughout the application; shadcn fills only documented gaps. Official elements' internal shadcn dependencies are accepted, not alternative application designs. The [128-element review](assistant-ui-elements.md) records the full-catalogue pass and its evidence limits. The existing dark theme remains the default.

This mapping is scoped to [pi-durable 1.5.2](pi-durable-features.md). A visual element does not authorize a new runtime capability, tool or host integration.

## Architecture and vocabulary

- One assistant-ui external-store runtime per mounted `Chat`, supplied from validated Hono/SSE snapshots. pi-durable remains authoritative for transcript, execution, queues and persistence.
- The official registry `Thread` owns layout, viewport, messages, actions and runtime composer. `Chat` binds the external-store runtime. A narrow `ComposerFooter` slot and native TriggerPopoverRoot integrate supplied slash, queue, confirmation and state elements outside the input shell, not another nested composer/menu.
- Activities belong in ordered reasoning/tool/data parts and, where justified, native reasoning/tool groups or RunActivity. Do not preserve the old Message/Trace/Marker wrappers as a second abstraction layer.
- The application owns routes, conversation selection, dimensions and provider/transport integration. Change the Chat's React key when switching conversations.
- Each instance keeps its own draft, scroll and disclosure state. Read-only views disable native input/actions and omit commands. Nonvisual host context lives in `chat-host.ts`, avoiding a circular presentation import.
- No Assistant Cloud, local transcript database, localStorage draft persistence, Vercel AI SDK runtime or client-side model/tool execution is enabled.

## 1. Conversation and messages

| Capability             | assistant-ui composition                                         | Status/boundary                                                                                 |
| ---------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Transcript and scroll  | Official Thread and its supplied viewport/footer/scroll controls | Adopted; centered reading surface and registered sticky composer                                |
| Participant content    | Message Root and Parts                                           | Adopted; durable IDs and order retained, no automatic adjacent-assistant merging                |
| Assistant text         | Thread's supplied MarkdownText element                           | Adopted: Markdown/GFM headings, lists, tables and fenced code with code-copy controls           |
| User text              | MessagePart Text                                                 | Adopted: literal text, line breaks and indentation preserved                                    |
| Message actions        | Thread's supplied action bar and More menu                       | Adopted Copy/Export; unsupported Refresh is omitted by runtime capability                       |
| Streaming              | Source-backed transient render identity                          | Adopted for unambiguous task-to-entry handovers; ambiguous/missed boundaries use canonical rows |
| Loading/empty          | Runtime state, skeleton and welcome composition                  | Adopted; initial loading is not an empty transcript                                             |
| Earlier history/gaps   | Native LoadEarlier adapter is the preferred paging surface       | Host paging, gap recovery and merge logic remain pending; recent-window notice retained         |
| Acknowledgement/retry  | Admission-aware composer submission and transport notices        | Preserves original payload/ID after uncertain delivery, not answer-completion claims            |
| Interrupted answer     | Incomplete status and typed interruption receipt                 | Cancellation, error and output limit remain distinct; Continue stays separate                   |
| Custom events/activity | Allowlisted text, omission and interruption parts                | Positioned omission receipts only; unknown custom entry data stays hidden                       |
| Images/files/sources   | Image/File/Attachment/Source elements and part renderers         | Require actual host/provider data; not enabled by this text-only migration                      |

Markdown does not enable raw HTML or code execution. Markdown image elements are disallowed rather than fetching remote URLs. Links are not verified citations. Neither Shiki nor Prism, math, Mermaid, maps nor arbitrary generative UI execution is installed just because the catalogue offers it.

### Transcript identity and projection (Batch 2)

The wire schema adds optional canonical parts, outcomes, entry/task attribution, conversation identity, retained-window entry IDs and live generation metadata. Original entry/model/content indexes survive filtering. Ordered text parts remain separated by coarse omission receipts (`reasoning`, `tool`, `image`, `other`); private reasoning, arguments, media, arbitrary type names, custom entry data and provider diagnostics are not forwarded. These receipts enable no new runtime capability.

SDK `aborted` is an interruption, `error` an error and `length` an incomplete output limit. Unknown/missing assistant stop reasons remain incomplete. A busy run is not necessarily a streaming assistant message: explicit `live: null` suppresses stale partial replay and false streaming on settled answers. Generic busy feedback says Working.

Render aliases are transient and separate from canonical durable IDs. A pure projector transfers the previous live row key only to exactly one new, known single-message SDK assistant entry attributed to the same task after the observed append boundary, while that boundary remains in the window or is its immediate predecessor. Task/attempt and append boundaries distinguish retries and reused attempts; no text-prefix or timestamp matching occurs. React layout effects commit the per-Chat cache. Canonical entry/part IDs remain separate metadata; future durable actions must not target render aliases.

Ambiguous multi-entry updates, another conversation/task, dropped boundaries and unattributed scheduler salvage fall back to canonical rows, not guesses. Tested success, Stop and model-error handovers retain the mounted row and Markdown part. Reconnect within the retained view keeps aliases; a full page load uses canonical history without browser persistence. Dropped rows lose their aliases. History paging and gap recovery remain deferred.

Strict wire validation rejects duplicate message/part identities and unknown wire part types. Rejected frames retain history/drafts, disable new actions and show a sanitized error. A later valid frame clears only that frame error, preserving uncertain-operation retries.

## 2. Composer and run controls

| Capability               | Composition                                                   | Semantics                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Multiline draft          | Official Thread composer                                      | Draft belongs to assistant-ui; Enter submits, Shift+Enter inserts newline, IME is preserved                                                                          |
| Send now/follow-up/steer | Native Send; runtime ComposerSlashCommands and TriggerPopover | `/queue` and `/steer` dispatch the current draft using explicit durable modes; idle steering never becomes an ordinary send                                          |
| Durable queue            | Supplied controlled MessageQueue below the composer           | SDK inbox only; mode labels distinguish boundary steering from next-run follow-up, and held input is not claimed delivered                                           |
| Withdraw                 | MessageQueue per-item removal callback                        | Placement race reports already-placed/settled/not-found honestly                                                                                                     |
| Stop                     | Native Stop bound to host abort                               | Also withdraws queued inputs; queued reset writes survive                                                                                                            |
| Continue                 | `/continue` selection                                         | Starts a run without adding user text or consuming the draft; not checkpoint Resume or Regenerate                                                                    |
| Reset/handoff            | `/reset` → supplied shadcn AlertDialog and Textarea           | One explicit Reset context action, optional multiline handoff; initial focus is Cancel, modal focus is contained and Escape/Cancel restores the originating composer |
| Attachments              | Thread capability gating                                      | Omitted while unsupported; no upload adapter or file picker                                                                                                          |

Steering is requested at an eligible boundary, not an immediate interruption. Continue eligibility comes from idle active model context ending in user content/tool results, with no queued reset, not the recent transcript window. Continue/reset admissions use request IDs for safe retry; reset uses the SDK's public reset-entry shape.

The input placeholder advertises `/`. Runtime `unstable_useSlashCommandAdapter` executes supplied callbacks on selection with `removeOnExecute: true`; selected command text is removed before the callback reads the remaining draft. Write a draft, then append `/queue` or `/steer` and select it, or insert a command before existing draft text. The picker supports native keyboard/ARIA behavior. It is not an argument parser. Availability follows committed host state; the host still validates admission. Raw reserved command names/prefixes are refused by native Send rather than becoming user messages after Escape or an eligibility change. Other slash text, such as paths not matching a reserved command prefix, remains ordinary input.

MessageQueue keeps the registry design but accepts host placement wording and an optional running row: durable queues need not have a current user prompt, steering is not next-run input, and failure can hold queued input. No native assistant-ui queue is populated or drained. These small semantic adaptations do not introduce a new visual queue design.

## 3. Agent activity, tools and tasks

Preferred elements: Reasoning, ToolFallback/ToolGroup, RunActivity, TerminalBlock, TaskCard and appropriate task/status disclosures. Preserve text/activity ordering and actual ownership. Use native GroupedParts only with supplied part data; never invent hidden reasoning, progress percentages, timings or tool results.

Tools, code execution, subagents, background work and task inspectors are not enabled. Tool retries, approvals and a Run now queue button need real host protocols; frontend callbacks alone do not supply durable semantics.

## 4. Context, configuration and usage

ModelSelector, reasoning effort, context displays/breakdowns and CostMeter are future presentation candidates backed by selected SDK projections. The current provider/model remain fixed server-side. Cumulative usage is not active context occupancy; unknown token breakdowns remain unknown. Browser model-context registration is not an automatic pi-durable configuration API.

Automatic/manual compaction, context inspection and configuration surfaces remain pending. Do not replace missing metrics with decorative rings or imply that a usage estimate is an invoice.

## 5. Recovery and connection

Connection, failure, cancellation and completion remain distinct. SSE disconnect detaches observation, not work; reconnect does not submit another run. Retain visible history and editable draft while observation is unavailable.

AgentStatus shows actual connection/admission/busy/reset/notice/interruption/read-only states; idle has no permanent Ready pill. ErrorState exposes Retry only for an actual original-operation callback. Do not adopt StoppedRun/ConnectionState defaults with unwired actions or unobserved server-progress claims. No request-ID-safe retry is offered for uncertain Stop, because a later abort could stop newer work.

Diagnostics, detailed task recovery, compaction failure detail and custom document inspection require sanitized host projections. Raw provider errors, paths and credentials stay private.

## 6. Adjacent integrations

ApprovalCard, PermissionGrant, ElicitationForm, OptionList/QuestionFlow and ReviewableDiff require durable host protocols, actual evidence and authorization. ElicitationForm is no longer used for reset: a human context-reset confirmation is not model/MCP elicitation. General elicitation and approval protocols remain unavailable.

ThreadList, sidebar/modal shells, forks, sharing and new-thread controls require application-owned navigation and APIs. Keep the contained thread reusable now rather than adding fake multi-conversation machinery.

## Current embedding contract

`src/client/chat.tsx` exports `Chat` and `ChatProps`. Supply title, optional description, validated presentation state (`null` during initial load), connection and pending/error/notice state. The parent supplies a bounded height. `src/client/chat-page.tsx` owns application integration; `src/client/use-chat.ts` owns the single-conversation API connection. No backend/data migration is needed for the UI change.

Omit `onSend` for read-only mode. Otherwise it receives text and optional send mode, returning true only for confirmed admission. `onStop`, `onContinue`, `onReset` and `onWithdraw` are optional host callbacks. `state.controls` gates advanced controls.

Native composer Send reaches the external-store `onNew` host adapter. Because native Send detaches its draft eagerly, the adapter immediately restores it if the composer is still empty. Only an unchanged draft clears after confirmed admission. Busy-mode slash commands use the same admission function without detachment. This preserves server authority without a second React draft store or an optimistic transcript.

After uncertain input/control delivery, the host supplies `uncertain`, an error and `onRetry`, with `retryText` or `retryAction`. Retain the original operation/payload/request ID. Other mutations stay blocked while a new draft remains editable. Continue/reset/withdraw do not consume the composer draft. Reset handoff text survives a failed attempt.

The transport serializes mutations and keeps retry identity only until refresh. Inspect restored state before repeating an uncertain action after refresh. Stop is a current-scope abort, not a request-ID admission; an uncertain Stop asks for state inspection before explicitly stopping again.

## Remaining work

Batch 2 adds source-backed live/committed identity and ordered text/omission projection with the fallback limits above. History paging/gap recovery, actual rich tool/reasoning/media payloads and application custom-event schemas remain deferred. The [catalogue review](assistant-ui-elements.md) distinguishes presentation candidates from host capabilities.

## shadcn gap decisions

**Reset confirmation is the one direct application-level shadcn gap.** assistant-ui supplies no dedicated context-reset confirmation dialog. ElicitationForm adds server/plug identity, “needs input,” an extra confirmation field and Send/Decline semantics; it is not an appropriate reset modal. Use the existing supplied shadcn **AlertDialog** for accessible modal confirmation and **Textarea** for optional multiline handoff. These provide Cancel / Reset context without another card, checkbox or custom visual component. Focus starts on Cancel, stays in the modal, and returns to the correct composer. Cancel/Escape changes no server state and retains handoff text; Reset context alone admits the existing operation. Failure retains the handoff and the original request-ID-safe retry; admission does not mean the reset has been placed.

The rest of Batch 1 remains assistant-ui-first: runtime ComposerSlashCommands/TriggerPopover, controlled MessageQueue, AgentStatus and ErrorState. Internal shadcn dependencies are accepted separately from this explicit fallback. No general dialog framework or new host capability is introduced. Future gaps must name the missing behavior and justify a specific supplied shadcn element or defer.
