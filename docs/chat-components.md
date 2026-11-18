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

| Capability             | assistant-ui composition                                         | Status/boundary                                                                                              |
| ---------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Transcript and scroll  | Official Thread and its supplied viewport/footer/scroll controls | Adopted; centered reading surface and registered sticky composer                                             |
| Participant content    | Message Root and Parts                                           | Adopted; durable IDs and order retained, no automatic adjacent-assistant merging                             |
| Assistant text         | Thread's supplied MarkdownText element                           | Adopted: Markdown/GFM headings, lists, tables and fenced code with code-copy controls                        |
| User text              | MessagePart Text                                                 | Adopted: literal text, line breaks and indentation preserved                                                 |
| Message actions        | Thread's supplied action bar and More menu                       | Adopted Copy/Export; unsupported Refresh is omitted by runtime capability                                    |
| Streaming              | Source-backed transient render identity                          | Adopted for unambiguous task-to-entry handovers; ambiguous/missed boundaries use canonical rows              |
| Loading/empty          | Runtime state, skeleton and welcome composition                  | Adopted; initial loading is not an empty transcript                                                          |
| Earlier history/gaps   | Native Thread LoadEarlier and supplied ErrorState recovery       | SDK-owned 50-entry pages/merge, retained view resume and explicit gap recovery; no false whole-history claim |
| Acknowledgement/retry  | Admission-aware composer submission and transport notices        | Preserves original payload/ID after uncertain delivery, not answer-completion claims                         |
| Interrupted answer     | Incomplete status and typed interruption receipt                 | Cancellation, error and output limit remain distinct; Continue stays separate                                |
| Custom events/activity | Allowlisted text, omission and interruption parts                | Positioned omission receipts only; unknown custom entry data stays hidden                                    |
| Images/files/sources   | Image/File/Attachment/Source elements and part renderers         | Require actual host/provider data; not enabled by this text-only migration                                   |

Markdown does not enable raw HTML or code execution. Markdown image elements are disallowed rather than fetching remote URLs. Links are not verified citations. Neither Shiki nor Prism, math, Mermaid, maps nor arbitrary generative UI execution is installed just because the catalogue offers it.

### Transcript identity and projection (Batch 2)

Batch 2 added optional canonical parts, outcomes, entry/task attribution, conversation identity, retained-window entry IDs and live generation metadata. Original entry/model/content indexes survive filtering. The native-tools increment projects validated tool calls, arguments and textual output alongside ordered text. Provider-supplied `thinking` text is now a native `reasoning` part; signatures/encrypted metadata, media, arbitrary custom entry data and provider diagnostics are not forwarded.

Reasoning uses the official [assistant-ui runtime composition](https://www.assistant-ui.com/elements/reasoning): Thread's GroupedParts, ReasoningRoot/Trigger/Content/Text and Markdown renderer, with the supplied `ghost` variant. It opens during reasoning streaming and collapses afterward unless the reader chose otherwise. Only actual provider text is rendered; empty reasoning produces no disclosure. No synthetic step titles, elapsed-time estimates or hidden-reasoning reconstruction is added. Older omission-only reasoning receipts render nothing, not a paused AgentStatus bar. ThinkingIndicator, loaders and typing indicators are transient activity feedback, ReasoningEffort is configuration, and GuardrailNotice requires an actual guardrail event; none substitutes for the reasoning trace.

SDK `aborted` is an interruption, `error` an error and `length` an incomplete output limit. Unknown/missing assistant stop reasons remain incomplete. A busy run is not necessarily a streaming assistant message: explicit `live: null` suppresses stale partial replay and false streaming on settled answers. Generic busy feedback says Working.

Render aliases are transient and separate from canonical durable IDs. A pure projector transfers the previous live row key only to exactly one new, known single-message SDK assistant entry attributed to the same task after the observed append boundary, while that boundary remains in the window or is its immediate predecessor. Task/attempt and append boundaries distinguish retries and reused attempts; no text-prefix or timestamp matching occurs. React layout effects commit the per-Chat cache. Canonical entry/part IDs remain separate metadata; future durable actions must not target render aliases.

Ambiguous multi-entry updates, another conversation/task, dropped boundaries and unattributed scheduler salvage fall back to canonical rows, not guesses. Tested success, Stop and model-error handovers retain the mounted row and Markdown part. Reconnect within the retained view keeps aliases; a full page load uses canonical history without browser persistence. Dropped rows lose their aliases. Paging preserves these evidence limits rather than treating loaded historical entries as a new live handover.

Strict wire validation rejects duplicate message/part identities and unknown wire part types. Rejected frames retain history/drafts, disable new actions and show a sanitized error. A later valid frame clears only that frame error, preserving uncertain-operation retries.

### Complete history access (Batch 3)

`src/server/history.ts` binds one transient SDK `ConversationTranscript` to each browser view. The SDK's `entries()`, `loadEarlier()`, `fillGap()` and `resume` window own page boundaries, deduplication, ordering and gap detection. Each read loads at most 50 entries; record IDs are bounds, not contiguous counts. Loaded entries remain in the view as the watched recent window advances. Full canonical projection is recomputed over the loaded entries, but tool-result pairing never crosses an unresolved gap.

Thread's supplied ghost LoadEarlier control binds to real `hasEarlier`/`onLoadEarlier`; its runtime manages loading state and its viewport handles prepends. Gap markers appear at their SDK boundaries using supplied ErrorState with actual Load missing messages/Retry callbacks, not fabricated assistant text. Markers have no durable message identity or copy/export actions. ErrorState's optional action/pending labels and disabled state describe history reads without changing its visual design.

The read-only `/api/history` operation accepts a validated view ID and optional gap bounds; it never submits a run. History loading/errors/retry are independent of mutation admission, drafts and uncertain-operation retry IDs. Revisions within a view epoch reject stale page responses; retired epochs and closed observers cannot overwrite a replacement view. There is no browser SDK mount, raw entry/document forwarding, history database or localStorage layer.

Disconnect stops the observer, not work. The cached SDK transcript resumes on reconnect and explicitly marks missing ranges. A detached view expires after 30 minutes. After host restart/cache loss, the browser's oldest-entry bound reconstructs one oldest page plus the latest window, with SDK gap markers for anything still missing. A full page refresh creates a new recent view; stored history remains pageable. A view UUID selects transient read state, not an authentication credential. The application is still one localhost conversation.

An empty terminal SDK page ends paging without dropping retained rows. Failed reads retain visible history and expose a read retry; no provider request or delivery retry is implied. Loaded-history navigation/search and whole-session search remain later work.

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

Native `read`, `write`, `edit`, `bash` and `powershell` now execute through pi-durable and NodeExecutionEnv. Arguments, running output and settled textual results use the supplied ToolFallback and Thread's tool grouping. A nonvisual adapter maps SDK pending/running/complete/error/cancelled/unavailable state to truthful labels. No approval, Run now or unsafe tool-retry callback is supplied. PowerShell needs an installed host executable.

Known `pi.tool-result` entries attach to the preceding unmatched call with the same SDK call ID and tool name, in transcript order. Reused call IDs in later rounds do not overwrite earlier results. Result entry IDs remain metadata separate from call-part identity. If the originating call has left the window, render the result as its own authoritative row with unknown arguments, not attached to a guessed call. Live progress overlays only an unsettled call owned by the current generation task; a missing result is unavailable, not successful. Arbitrary result details/documents are ignored. Output is rendered as literal text, never executed as HTML/JS.

Tool output/arguments can contain sensitive local data: they are intentionally visible to the local user and persisted by the SDK, unlike hidden provider diagnostics. Image output currently receives a non-text receipt. The [parity inventory](pi-durable-features.md#pi-tui-parity) records the remaining feature work; subagents/background/task inspectors are not implemented by this increment.

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

Optional `onLoadEarlier`/`onFillGap` bind history reads, with separate `historyLoading`, `historyGap`, `historyError` and `onRetryHistory`. Read-only embeddings may still page if their host supplies these callbacks. Without a paging adapter, the earlier-history notice remains informational.

Native composer Send reaches the external-store `onNew` host adapter. Because native Send detaches its draft eagerly, the adapter immediately restores it if the composer is still empty. Only an unchanged draft clears after confirmed admission. Busy-mode slash commands use the same admission function without detachment. This preserves server authority without a second React draft store or an optimistic transcript.

After uncertain input/control delivery, the host supplies `uncertain`, an error and `onRetry`, with `retryText` or `retryAction`. Retain the original operation/payload/request ID. Other mutations stay blocked while a new draft remains editable. Continue/reset/withdraw do not consume the composer draft. Reset handoff text survives a failed attempt.

The transport serializes mutations and keeps retry identity only until refresh. Inspect restored state before repeating an uncertain action after refresh. Stop is a current-scope abort, not a request-ID admission; an uncertain Stop asks for state inspection before explicitly stopping again.

## Remaining work

Source-backed live/committed identity, paged history/gap recovery and ordered text/reasoning/tool/omission projection retain the limits above. Loaded-turn navigation/search, media renderers, richer tool-specific result displays and application custom-event schemas remain unimplemented. The [catalogue review](assistant-ui-elements.md) distinguishes presentation candidates from host capabilities.

## shadcn gap decisions

**Reset confirmation is the one direct application-level shadcn gap.** assistant-ui supplies no dedicated context-reset confirmation dialog. ElicitationForm adds server/plug identity, “needs input,” an extra confirmation field and Send/Decline semantics; it is not an appropriate reset modal. Use the existing supplied shadcn **AlertDialog** for accessible modal confirmation and **Textarea** for optional multiline handoff. These provide Cancel / Reset context without another card, checkbox or custom visual component. Focus starts on Cancel, stays in the modal, and returns to the correct composer. Cancel/Escape changes no server state and retains handoff text; Reset context alone admits the existing operation. Failure retains the handoff and the original request-ID-safe retry; admission does not mean the reset has been placed.

The rest of Batch 1 remains assistant-ui-first: runtime ComposerSlashCommands/TriggerPopover, controlled MessageQueue, AgentStatus and ErrorState. Internal shadcn dependencies are accepted separately from this explicit fallback. No general dialog framework or new host capability is introduced. Future gaps must name the missing behavior and justify a specific supplied shadcn element or defer.
