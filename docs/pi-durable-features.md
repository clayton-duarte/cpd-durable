# pi-durable feature inventory

Inventory of **`@earendil-works/pi-durable` 1.5.2**, pinned in this repository, inspected on 2026-11-17. The SDK is experimental; capabilities on upstream `main` can differ from this release. This inventory is a capability map, not an implementation commitment or authorization to enable tools or a fixed agent hierarchy.

Evidence: the published package's [README](https://unpkg.com/@earendil-works/pi-durable@1.5.2/README.md), [public exports](https://unpkg.com/@earendil-works/pi-durable@1.5.2/dist/index.d.ts) and [package manifest](https://unpkg.com/@earendil-works/pi-durable@1.5.2/package.json), checked against our server, presentation schema and client. SDK claims below are documentation/API evidence, not independent tests of every feature. See [our verification boundaries](../README.md#checks).

## Reading the status

- **Exposed:** the current chat offers this behavior.
- **Underlying:** the SDK supplies it behind the current chat, but no dedicated UI/control exposes it; some behavior is an SDK default, not exercised by our tests.
- **Not integrated:** application wiring, UI, permissions or dependencies would be needed.

The current app is one root conversation with a fixed OpenCode Go model, no tools and an empty extension registry. [Server setup](../src/server/chat.ts), [HTTP/SSE endpoints](../src/server/app.ts), [presentation filtering](../src/server/presentation.ts) and [client](../src/client/chat.tsx) are the implementation evidence. This PR changes the default theme only; it enables none of the additional SDK capabilities below.

## Conversation and chat experience

| Capability                         | SDK support                                                                                                                               | Current chat                                                                                                                          |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Submit and settle input            | `submit()`, `Submission.wait()`, `done` / `unanswered` outcomes; optional request IDs deduplicate admission                               | **Exposed:** text input and retry IDs; no submission inspector                                                                        |
| Stream and attach mid-run          | `watch()` supplies initial conversation view and committed changes, including live partials and tool output                               | **Exposed:** Hono SSE sends filtered snapshots; reconnect attaches to current state rather than replaying old SSE events              |
| Transcript history                 | Immutable entries, `entries()` paging, `ConversationTranscript` merging, earlier pages and gap filling                                    | **Exposed:** recent window only, with an earlier-history notice. **Not integrated:** load-earlier/gap controls                        |
| Busy input                         | Follow-up queue, steering, idle/busy rejection, passive writes and queued-submission withdrawal                                           | **Exposed:** busy rejection only; composer cannot send during a run. **Not integrated:** queue/steer/withdraw controls                |
| Stop                               | `abort()` withdraws queued inputs and aborts owned foreground work; background work is an explicit boundary                               | **Exposed:** Stop and interrupted partials; no background work exists in this app                                                     |
| Continue after failure/stop        | `submit({ type: "continue" })` retries the remaining context without adding user text; rejects while busy                                 | **Not integrated:** current recovery is another user message, not a Continue button                                                   |
| Reset / handoff                    | `reset()` starts new model context while preserving old entries; optional handoff text; tools can request handoff                         | **Not integrated:** no reset/new-chat/handoff UI. Reset is not transcript deletion                                                    |
| Additional conversations / forks   | `createConversation()`; `fork(entryId, ...)` continues parent history independently with a fresh provider identity                        | **Not integrated:** one conversation only; topology and ownership UX remain open                                                      |
| Agent choices                      | `configure()` changes model, thinking level, instructions, extensions, tools, directory, compaction and tool-round limit per conversation | **Underlying:** fixed model and empty tools reapplied at startup. **Not integrated:** selectors, instructions editor or mode controls |
| Reasoning and richer message parts | Provider message content and live generation data can contain more than text; tool results have UI details                                | **Not integrated:** presentation deliberately selects text only. Availability also depends on pi-ai and the model                     |
| Multimodal input                   | SDK input/model content can carry images; image helpers can decode, orient, resize and fit tool-read images                               | **Not integrated:** text-only input, no uploads, image processing or rendering                                                        |

## Context, usage and observability

| Capability                  | SDK support                                                                                                                               | Current chat                                                                                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Active model context        | `context()` reads the active transcript; reset/compaction distinguish model context from raw history                                      | **Not integrated:** no context inspector or context-window meter                                                                                                 |
| Compaction                  | Manual `compact()`, automatic/background thresholds, overflow recovery, summaries preserved as entries; per-model/per-conversation policy | **Underlying:** automatic SDK defaults are not disabled. **Not integrated/tested:** compaction controls, progress/failure presentation or long-context scenarios |
| Token usage / cost          | `pi.usage` per conversation and `harness.usage()` for the session; per-model/tool totals include failed/aborted attempts                  | **Underlying:** SDK accounting. **Not integrated:** usage/cost UI; reported cost is not a billing guarantee                                                      |
| Live state                  | `pi.live` tracks run, generation, retry/deferred progress, tools and compactions; `pi.inbox` holds queued submissions                     | **Exposed:** busy, partial text, generic retry/failure notices. Other fields are filtered out                                                                    |
| Failure and recovery detail | `runFailure`, `inspect()`, missing-definition/migration reports, task inspection and settlement records                                   | **Exposed:** sanitized failure category only. **Not integrated:** detailed recovery/task inspector; raw provider diagnostics stay private                        |
| Task visibility             | `watchTaskGraph()` exposes live task ownership/status; `inspect()` adds information such as blocked definitions                           | **Not integrated:** no graph/tree/task panel. A live task graph is not a project plan or permanent outcome ledger                                                |
| Watches and observers       | Conversation/document/task watches; synchronous observation and commit observation for adapters                                           | **Underlying:** conversation watch only; no direct browser SDK mounting or generic adapter layer                                                                 |
| Telemetry and reports       | Optional host-owned telemetry spans/metrics/propagation; typed schema and `onReport` categories                                           | **Underlying:** category-only report logging. **Not integrated:** telemetry backend, dashboards or transcript logging                                            |

SDK records useful state that our wire schema intentionally omits. Enriching the UI should expose selected fields through validated presentation schemas, not forward all SDK documents or private diagnostics.

## Tools and extensibility

| Capability              | SDK support                                                                                                                                    | Current chat                                                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Coding tools            | Optional `read`, `write`, `edit`, `bash` / `CodingTools`; calls use a host-provided execution environment                                      | **Not integrated:** explicitly no tools or execution environment                                                                   |
| Custom tools            | `defineTool()`, schema validation, streamed output, structured program results, UI details and diagnostics                                     | **Not integrated:** tool installation and UI/authority boundaries would be new scope                                               |
| Tool-to-tool execution  | `executeTool()`, nested-call visibility, keyed replay, allowed callers, separate model-offered/callable tool sets                              | **Not integrated:** no nested tools, caller policy or nested-output UI                                                             |
| Deferred tool discovery | `createToolSearchExtension()` searches and loads deferred tools; selected tools survive compaction on that branch                              | **Not integrated:** no catalog/search UI or MCP bridge                                                                             |
| Code mode               | Optional QuickJS extension; scripts call tools, discover declarations, keep conversation-local values and replay journaled calls after restart | **Not integrated:** not a general host sandbox or permission system; actual tools still need authorized environments               |
| Extension registry      | Named bundles of tools, prompt sections, hooks, wrappers and tasks; install, replace, uninstall while running                                  | **Underlying:** empty registry only. **Not integrated:** extension selection/loading/reload UI                                     |
| Prompt composition      | Extension `section()` contributions, conversation instructions and positional prompt/tool changes                                              | **Underlying:** SDK prompt handling. **Not integrated:** custom skills/role prompts or prompt editor                               |
| Hooks / wrapping        | Request/provider-request/response, yield, tool-round, before/after-tool and compaction hooks; tool/section decorators                          | **Not integrated:** no host approval protocol. A `beforeTool` hook can block a call, but does not itself provide an approval Inbox |
| After-run tasks         | `afterRun` and `runEndTask()` can start durable follow-up tasks; answer settles before these tasks finish, while conversation stays busy       | **Not integrated:** no automatic test/review/fix loop; examples are not mandatory delivery choreography                            |
| Execution environments  | Node environment and custom filesystem/process interfaces; environments can follow each conversation's directory or sandbox                    | **Not integrated:** no local filesystem/process access, sandbox selection or environment UI                                        |

MCP connectivity, credential handling and a human approval workflow require host integration; tool names or extension examples are not proof of turnkey support in this app. Similarly, a skill directory, slash-command palette, Markdown renderer, attachments UI and model picker are not supplied by the durable harness as a browser application.

## Durability, state and parallel execution

| Capability                                 | SDK support                                                                                                                             | Current chat                                                                                                                   |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Persist / reopen / resume                  | Harness over durable storage; persistent provider session identity; `resume()` schedules interrupted work                               | **Exposed:** Node SQLite persistence and reopen/resume. This is not an automatic OS service supervisor                         |
| Retry and crash limits                     | Request retry policy, deferred-response polling, restart-limit termination and distinct failure reasons                                 | **Underlying:** two request retries configured; broader crash-loop cases are SDK behavior, not all app-tested                  |
| Tool replay safety                         | Tools opt into safe replay; nested calls keep replay receipts. Unsafe interrupted calls produce errors rather than blindly repeat       | **Not integrated:** no tool calls. External side effects still need their own idempotency; no universal exactly-once guarantee |
| Durable tasks                              | `defineTask()`, checkpointed phases, timers/sleep, task ownership and waiting/completing/abort states                                   | **Underlying:** built-in model generation. **Not integrated:** custom tasks, reminders or scheduler UI                         |
| Child tasks and subagents                  | Task-owned conversations/tasks, ownership-aware stop/idle behavior, foreground/background patterns and join policies                    | **Not integrated:** no helpers or threads. Examples demonstrate mechanisms, not a chosen CPD hierarchy                         |
| Typed application state                    | `defineDoc()` / document families, session/conversation/task scopes, atomic commits with entries/tasks, history/fork policy and watches | **Underlying:** built-in documents only. **Not integrated:** custom project memory or app-owned documents                      |
| Custom entries and transactional admission | Host entry kinds, model-facing content separate from display data, `submit(tx, draft)` admitted with related writes                     | **Not integrated:** no custom entry type or extra operational recordkeeping                                                    |
| Storage backends                           | Memory, Node SQLite, JSONL, browser IndexedDB, Cloudflare Durable Object SQLite, portable adapters and Chord Store storage              | **Underlying:** Node SQLite only. Browser persistence, alternative deployment and custom stores are not adopted                |
| Read-only hosts and conformance tests      | Read-only Harness; backend-specific read-only rules; storage/environment conformance helpers                                            | **Not integrated:** no read-only viewer, custom backend or environment                                                         |

Durability has limits: partial progress can be shown before its deferred persistence window closes; SQLite uses WAL with `synchronous = NORMAL`, so process-crash recovery is not a power-loss guarantee. The SDK requires one writer per storage; the app obtains its fixed loopback listener before opening writable storage. Cancelling observation/waiting does not itself cancel work. Preserve these distinctions in new UI controls.

## Candidate enrichment, not a selected backlog

For discussion, the closest additions to the existing single-chat boundary are:

1. Earlier-history loading and clearer submission/run status.
2. Usage/cost display, followed by honest context/compaction visibility.
3. Reasoning display where the provider supplies it.
4. Explicit Continue, reset and busy-input queue/steer choices, with clear semantics.

Tools, approvals, multimodal input, forks, helpers and project-scale orchestration require additional scope/authority decisions. None is authorized simply by appearing in this inventory. The [design proposals](design.md#proposal-project-conversations-and-interactive-threads) remain open.

## Maintenance

When the pinned SDK changes, revisit this inventory against that package's README, exported types and our integration. Do not silently substitute upstream `main` documentation for release evidence. The 1.5.2 README's contents list mentions “Agent Events (Experimental)” without a corresponding section; this inventory does not infer an event API from that dangling reference.
