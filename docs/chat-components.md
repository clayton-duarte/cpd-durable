# Chat capability mapping

Settled direction, updated 2026-11-17: **assistant-ui > shadcn; no custom visual components**. Use supplied assistant-ui elements throughout the application; shadcn fills only documented gaps. Official elements' internal shadcn dependencies are accepted, not alternative application designs. The [128-element review](assistant-ui-elements.md) records the full-catalogue pass and its evidence limits. The existing dark theme remains the default.

This mapping is scoped to [pi-durable 1.5.2](pi-durable-features.md). A visual element does not authorize a new runtime capability, tool or host integration.

## Architecture and vocabulary

- One assistant-ui external-store runtime per mounted `Chat`, supplied from validated Hono/SSE snapshots. pi-durable remains authoritative for transcript, execution, queues and persistence.
- The official registry `Thread` owns layout, viewport, messages, actions and composer. `Chat` binds the external-store runtime; its `ComposerExtra` slot composes supplied elements for durable controls. No application-owned message/composer presentation remains.
- Activities belong in ordered reasoning/tool/data parts and, where justified, native reasoning/tool groups or RunActivity. Do not preserve the old Message/Trace/Marker wrappers as a second abstraction layer.
- The application owns routes, conversation selection, dimensions and provider/transport integration. Change the Chat's React key when switching conversations.
- Each instance keeps its own draft, scroll and disclosure state. Read-only views disable native input/actions and omit the durable action palette.
- No Assistant Cloud, local transcript database, localStorage draft persistence, Vercel AI SDK runtime or client-side model/tool execution is enabled.

## 1. Conversation and messages

| Capability             | assistant-ui composition                                                    | Status/boundary                                                                          |
| ---------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Transcript and scroll  | Official Thread and its supplied viewport/footer/scroll controls            | Adopted; centered reading surface and registered sticky composer                         |
| Participant content    | Message Root and Parts                                                      | Adopted; durable IDs and order retained, no automatic adjacent-assistant merging         |
| Assistant text         | Thread's supplied MarkdownText element                                      | Adopted: Markdown/GFM headings, lists, tables and fenced code with code-copy controls    |
| User text              | MessagePart Text                                                            | Adopted: literal text, line breaks and indentation preserved                             |
| Message actions        | Thread's supplied action bar and More menu                                  | Adopted Copy/Export; unsupported native Refresh is disabled, not a host regeneration API |
| Streaming              | In-place running assistant part                                             | Adopted; no simulated word replay. Live-to-committed identity still needs host work      |
| Loading/empty          | Runtime state, skeleton and welcome composition                             | Adopted; initial loading is not an empty transcript                                      |
| Earlier history/gaps   | Native LoadEarlier adapter is the preferred paging surface                  | Host paging, gap recovery and merge logic remain pending; recent-window notice retained  |
| Acknowledgement/retry  | Admission-aware composer submission and transport notices                   | Preserves original payload/ID after uncertain delivery, not answer-completion claims     |
| Interrupted answer     | Incomplete status plus typed interruption data part rendered by AgentStatus | Adopted without misclassifying interruption as an error; Continue remains separate       |
| Custom events/activity | Typed message data parts or explicit event projection                       | Pending; no raw SDK document dump                                                        |
| Images/files/sources   | Image/File/Attachment/Source elements and part renderers                    | Require actual host/provider data; not enabled by this text-only migration               |

Markdown does not enable raw HTML or code execution. Markdown image elements are disallowed rather than fetching remote URLs. Links are not verified citations. Neither Shiki nor Prism, math, Mermaid, maps nor arbitrary generative UI execution is installed just because the catalogue offers it.

## 2. Composer and run controls

| Capability               | Composition                                                          | Semantics                                                                                              |
| ------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Multiline draft          | Official Thread composer                                             | Draft belongs to assistant-ui; Enter submits, Shift+Enter inserts newline, IME is preserved            |
| Send now/follow-up/steer | Native Send; supplied CommandPalette in ComposerExtra for busy modes | Explicit durable mode; idle steering is refused rather than silently starting another run              |
| Durable queue            | CommandPalette queued-input group and AgentStatus count              | SDK inbox only, separate from delivered messages; no second browser queue                              |
| Withdraw                 | Per-item CommandPalette command                                      | Placement race reports already-placed/settled/not-found honestly                                       |
| Stop                     | Native Stop bound to host abort                                      | Also withdraws queued inputs; queued reset writes survive                                              |
| Continue                 | CommandPalette command                                               | Starts a run without adding user text; not checkpoint Resume or Regenerate                             |
| Reset/handoff            | CommandPalette → supplied ElicitationForm                            | Explicit confirmation choice and optional text field; history remains; busy reset waits for a boundary |
| Attachments              | Thread's supplied attachment control                                 | Disabled by runtime capability; no upload adapter or file picker available                             |

Steering is requested at an eligible boundary, not an immediate interruption. Continue eligibility comes from idle active model context ending in user content/tool results, with no queued reset, not the recent transcript window. Continue/reset admissions use request IDs for safe retry; reset uses the SDK's public reset-entry shape.

## 3. Agent activity, tools and tasks

Preferred elements: Reasoning, ToolFallback/ToolGroup, RunActivity, TerminalBlock, TaskCard and appropriate task/status disclosures. Preserve text/activity ordering and actual ownership. Use native GroupedParts only with supplied part data; never invent hidden reasoning, progress percentages, timings or tool results.

Tools, code execution, subagents, background work and task inspectors are not enabled. Tool retries, approvals and a Run now queue button need real host protocols; frontend callbacks alone do not supply durable semantics.

## 4. Context, configuration and usage

ModelSelector, reasoning effort, context displays/breakdowns and CostMeter are future presentation candidates backed by selected SDK projections. The current provider/model remain fixed server-side. Cumulative usage is not active context occupancy; unknown token breakdowns remain unknown. Browser model-context registration is not an automatic pi-durable configuration API.

Automatic/manual compaction, context inspection and configuration surfaces remain pending. Do not replace missing metrics with decorative rings or imply that a usage estimate is an invoice.

## 5. Recovery and connection

Connection, failure, cancellation and completion remain distinct. SSE disconnect detaches observation, not work; reconnect does not submit another run. Retain visible history and editable draft while observation is unavailable.

AgentStatus shows connection/admission/reset/notice/interruption states. ErrorState exposes Retry only for an actual original-operation callback. Do not adopt StoppedRun/ConnectionState defaults with unwired actions or unobserved server-progress claims. No request-ID-safe retry is offered for uncertain Stop, because a later abort could stop newer work.

Diagnostics, detailed task recovery, compaction failure detail and custom document inspection require sanitized host projections. Raw provider errors, paths and credentials stay private.

## 6. Adjacent integrations

ApprovalCard, PermissionGrant, OptionList/QuestionFlow and ReviewableDiff require durable host protocols, actual evidence and authorization. ElicitationForm currently confirms the existing reset operation only; it does not enable general model elicitation or approval protocols.

ThreadList, sidebar/modal shells, forks, sharing and new-thread controls require application-owned navigation and APIs. Keep the contained thread reusable now rather than adding fake multi-conversation machinery.

## Current embedding contract

`src/client/chat.tsx` exports `Chat` and `ChatProps`. Supply title, optional description, validated presentation state (`null` during initial load), connection and pending/error/notice state. The parent supplies a bounded height. `src/client/chat-page.tsx` owns application integration; `src/client/use-chat.ts` owns the single-conversation API connection. No backend/data migration is needed for the UI change.

Omit `onSend` for read-only mode. Otherwise it receives text and optional send mode, returning true only for confirmed admission. `onStop`, `onContinue`, `onReset` and `onWithdraw` are optional host callbacks. `state.controls` gates advanced controls.

Native composer Send reaches the external-store `onNew` host adapter. Because native Send detaches its draft eagerly, the adapter immediately restores it if the composer is still empty. Only an unchanged draft clears after confirmed admission. Busy-mode palette commands use the same admission function without detachment. This preserves server authority without a second React draft store or an optimistic transcript.

After uncertain input/control delivery, the host supplies `uncertain`, an error and `onRetry`, with `retryText` or `retryAction`. Retain the original operation/payload/request ID. Other mutations stay blocked while a new draft remains editable. Continue/reset/withdraw do not consume the composer draft. Reset handoff text survives a failed attempt.

The transport serializes mutations and keeps retry identity only until refresh. Inspect restored state before repeating an uncertain action after refresh. Stop is a current-scope abort, not a request-ID admission; an uncertain Stop asks for state inspection before explicitly stopping again.

## Remaining work

The UI migration does not silently complete previously deferred history paging, gap recovery, stable live-to-committed identity, ordered rich SDK projection or custom events. Richer assistant Markdown is now adopted as part of the assistant-ui pivot; attachments/tools/sources and the wider host capabilities remain deferred. The [catalogue review](assistant-ui-elements.md) distinguishes ready-to-use primitives, data-dependent renderers, alternative shells and entirely new host capabilities.

## shadcn gap decisions

There are **no direct application-level shadcn fallbacks** in the current chat. Thread and the selected standalone assistant-ui elements bring their supplied Button, Tooltip, Dialog, Avatar and other shadcn dependencies. These remain internal implementation dependencies, not permission to compose a competing chat UI. Durable semantics use CommandPalette, ElicitationForm, AgentStatus and ErrorState rather than bespoke buttons, queue rows or confirmation dialogs. Future gaps must first name the missing assistant-ui capability and justify a specific supplied shadcn element; otherwise defer the surface.
