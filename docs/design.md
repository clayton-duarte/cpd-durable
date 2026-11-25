# Design direction

This document records the User's settled fresh-start decisions and still-open discussion; individual sections identify later decisions. “Settled” means selected direction, not implemented behavior. See the [repository status](../README.md#current-status) and [problem and learning](problem-and-learning.md) for context.

## Settled baseline

Methodology comes first; the platform enables it. Skills carry the methodology. The platform remains necessary for model access, interaction, approvals and human control; methodology-first does not mean tooling-free.

- **Convention over configuration.** Follow the upstream default unless the user explicitly chooses an override. Do not make users confirm a choice they did not make. For thinking effort, **Default** means the provider request omits the effort setting so the provider can choose. It is not **Off** or a Pi-selected effort.
- New CPD tooling is full TypeScript; no Rust-retention carve-out was selected.
- WebUI/Cockpit and upstream pi-durable are the only retained platform foundations. Cockpit is the target human control interface.
- pi-agent+tmux and the TUI are dropped from the target; their removal from the legacy runtime is not claimed.
- No previous machinery is inherited by default. A capability must first be genuinely missed and justify adoption. This applies to the Ledger, scheduler, CLI, state machine, adapters, durable-host wrappers, guards, integrations and tests.
- Preserving decisions, data and evidence is separate from retaining their machinery. The reset is not permission to delete legacy data.

The existing WebUI and durable wrappers still depend on the old CPD CLI and Context/Plan/session contracts. They are not independent drop-in modules. Retaining their foundation is a direction, not proof that copying them produces the target platform.

The accepted [delivery lessons](problem-and-learning.md#lessons-for-this-reset) govern future mechanisms: preserve intent, bounded authority, real dependencies, outcome evidence, usable recovery and human control without prescribing every legitimate execution strategy.

## Minimal runtime slice

After the documentation foundation, the User authorized one browser chat backed by one pi-durable session, deliberately deferring multi-project orchestration.

Selected stack: Vite+, pnpm, React, TanStack Router, assistant-ui, Hono, Zod and `@tsconfig/strictest`. Component priority is **assistant-ui > shadcn** across the application: use supplied assistant-ui elements first; shadcn may fill only a documented gap. No custom visual components. Application adapters may compose supplied elements and bind real host behavior; official elements' internal shadcn dependencies are accepted. The User's 2026-11-17 pivot replaces the earlier shadcn AI Elements constraint and calls for full-catalogue review, not a one-for-one wrapper swap. Use current compatible releases and lock them; the SDK's experimental API makes version alignment important.

The User prefers borderless components inside chat messages. Choose supplied `ghost`/borderless variants for inline disclosures such as reasoning and tool groups, rather than bordered cards or custom CSS replacements. This preference does not remove functional input boundaries or restyle confirmation dialogs.

One package contains `src/client`, `src/server` and browser-safe `src/shared` modules. Package extraction is deferred until independent consumers, deployments or dependency isolation justify it. Zod validates application boundaries, without replacing the SDK's internal schema mechanisms.

The initial implementation was localhost-only and text-only, with OpenCode Go's `deepseek-v4.1-flash` fixed server-side. The User clarified that the earlier OpenRouter reference was a misstatement; OpenCode Go is the intended provider. Hono relays validated input and SDK conversation watches over SSE (`streamSSE`); the SDK owns execution, retries and SQLite persistence. Browser state is transient. There is no separate transcript database, legacy wrapper or orchestration service. Native-tool registry population was added under the later authorization below.

This initial slice implemented send/stream/stop, recent history, reconnect and reopen/resume. [Running instructions and verification boundaries](../README.md#checks) distinguish local tests with a substituted provider from live-provider verification. The later native-execution authorization below expands it; LAN/public exposure and legacy migration remain separate.

The accepted [chat component mapping](chat-components.md) defines reusable containment and assistant-ui presentation; the [element review](assistant-ui-elements.md) classifies the complete catalogue. Native UI/runtime composition adapts existing pi-durable state rather than replacing its execution/persistence with Assistant Cloud or a second agent runtime. Mapping an element does not authorize enabling additional host capabilities.

On 2026-11-17 the User expanded the browser surface to chat creation and navigation using TanStack Router and supplied assistant-ui sidebar/thread-list elements. Independent ownerless SDK conversations share one Harness and its storage; this does not select a project/task hierarchy, forks or orchestration. ThreadListSidebar and ThreadList supply navigation. AssistantSidebar is an app/copilot split with its own Thread, not a conversation-navigation shell, so it is not nested into this workspace. See [implemented semantics and limits](chat-components.md#chat-navigation-and-creation).

The User subsequently requested one active empty new chat at a time and per-chat context menus for archive/delete. New chat reuses the durable empty conversation. Archive is reversible; deletion removes the chat from the app with explicit confirmation, not physical SDK-record erasure. The pinned SDK has no public conversation-purge operation.

## Native execution and pi TUI parity

Model tiers are role-wide so a provider change carries existing conversations along. See [model configuration semantics](chat-components.md#4-context-configuration-and-usage).

On 2026-11-17, after Batch 2, the User authorized making cpd fully usable with pi TUI's tools and features, without cpd-added approval prompts or sandbox restrictions, and selected `~/` as the default working directory. It is a starting context, not a filesystem boundary. Tools execute with the server account's OS permissions and inherited environment; cpd does not bypass OS access controls or supply unavailable external programs.

The first implementation installs pi-durable's native `read`, `write`, `edit`, `bash` and `powershell` tools, supplies `NodeExecutionEnv`, and renders tool calls/output through assistant-ui. PowerShell requires an installed executable. No command/path denylist, approval hook, forced command timeout or tool-round cap is added. SDK argument validation, bounded output/spill handling, cancellation and non-replay-safe side-effect semantics remain correctness behavior, not an application permission gate.

pi-durable remains the sole execution/transcript/persistence authority; this direction does not select a second TUI/agent runtime. The [parity inventory](pi-durable-features.md#pi-tui-parity) distinguishes actual capability from remaining implementation. Keep the localhost transport and server-only credential handling; executing commands can access secrets available to the account and can deliberately emit sensitive output into private conversation storage.

## Proposal: project conversations and interactive threads

The earlier proposal is superseded for interactive conversations by the following User-approved design, with implementation authorized on 2026-11-18. The heading remains for existing links. Multi-project organization and a global attention Inbox remain deferred. Authorization is not completion.

### Main threads, tangents and workers

| Role        | Interaction and purpose                                                                                 | Default model assignment                               |
| ----------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Main thread | Existing sidebar conversation; high-level planning, decisions and consolidation                         | High-capability tier                                   |
| Tangent     | Fresh interactive conversation for focused exploration or involved execution, linked to one main thread | Mid-tier                                               |
| Worker      | Headless bounded execution, supervised and reviewed by its immediate parent                             | Economical tier; parent may explicitly select mid-tier |

Settings name the model tiers and assign real configured models. Thread and worker UI shows actual model names, not intelligence labels. These are defaults, not competence guarantees or permission boundaries; no silent model fallback or escalation is selected. Initially only main threads create interactive tangents; both main threads and tangents can delegate workers.

Parents own their children's scope, coordination, deliverables and review. Code changes use separate branches and worktrees, never direct edits to `main`; concurrent access to shared files or external services still requires coordination. Separate conversation context does not isolate external effects or impose a filesystem sandbox.

### Handoffs and context

Delegation, updates, escalation and return reports use durable, versioned handoffs. Tangents start with selected grounding linked to a source conversation boundary, not an inherited full transcript. A delegation brief includes the goal, decisions, constraints and exclusions, references, suggested skills, permitted discretion and expected deliverable. Updates and escalations identify changed assumptions or decisions needed. Return reports identify outcomes, artifacts, evidence, limitations and unresolved issues.

The User selected the principles of the external [handoff skill](https://github.com/mattpocock/skills/tree/main/skills/productivity/handoff): tailor context to the next goal, reference existing artifacts rather than duplicate them, suggest relevant skills and redact sensitive information. Its temporary-file storage is not the application persistence contract; application handoffs belong in pi-durable records.

Subsequent updates are explicit; a changed file or stored brief is not proof an active agent read it. Delivery, acknowledgement and acceptance must not be conflated. Results default to notification without automatically injecting tangent activity into the main model context. Bringing findings back is an explicit, retry-safe operation; the parent reviews and consolidates rather than treating a returned report as accepted.

### Interaction and presentation

`/tangent` is the canonical creation command, with `/side` as an alias; clear prose requests may invoke the same real creation tool. Creation and starting work are explicit choices. Opening a pane, reading state or reconnecting never implicitly starts a paid request. Main conversation progress does not wait for tangent completion.

Each parent displays its immediate children above its chat: supplied TaskCard for tangents and supplied AgentStatus for workers. All open tangents, including idle and running ones, remain visible and selectable. Selecting a tangent opens its full conversation beside the main thread with a vertical divider. One adjacent tangent is displayed at a time; drafts, scroll, model choices and controls remain independently scoped. Narrow screens use a pane switcher while retaining parent/child orientation. Closing a pane is navigation, not cancellation, conclusion or archival.

Stopping a main response does not implicitly stop its independent tangent conversations. Worker foreground/background ownership and explicit stop actions must be truthful. Conversation lifecycle (open, concluded, archived), current activity and attention/reporting are separate dimensions: a settled assistant response does not conclude a tangent, and report availability does not mean parent acceptance. Status uses text and icons, not color alone; no invented progress percentages.

### Delivery sequence and remaining questions

Implementation proceeds through durable tangent creation and split-chat navigation, explicit context updates and return handoffs, worker lifecycle integration, then refinements from real use. Model-tier settings support launch selection. The supervisor coordinates shared schemas and integration; independently tested but unwired modules are not completed features.

Remaining design work includes promotion of a tangent to a main thread, deeper interactive nesting if justified, and broader multi-project organization. A filesystem living-brief watcher, automatic context synchronization and a global attention Inbox are not selected by this authorization.

## Continuous parallel delivery

On 2026-11-18 the User identified repeated cross-PR conflict repair during CPD's own development as a problem CPD should solve. The [delivery incident and lessons](problem-and-learning.md#parallel-implementation-is-not-continuous-delivery) are the authoritative history. The selected goal is continuous parallel delivery: independent work can proceed while compatible, reviewed increments keep landing, without making the User repeatedly coordinate rebases and integration repair.

**Design implications, not implemented capabilities:** coordination needs to account for shared integration ownership and real dependencies before dispatch, not infer independence from separate conversations or worktrees. A result should identify the base and contracts it was built against; verification must remain attributable to its tested head and base. A changed base can require renewed integration evidence, and an integration conflict needs a responsible owner and a concrete next action.

**Open mechanisms:** how to surface overlapping ownership, express dependencies, bound integration work in progress, and invalidate affected evidence without repeatedly refreshing every branch. An integration owner, dependency-aware stacking, stable module contracts and a landing queue are candidate techniques, not a selected scheduler or mandatory role hierarchy. Textual conflict detection alone cannot establish semantic compatibility.

For this repository's current backlog, the User selected creation-order landing; that operational policy is not a universal product queue algorithm. Parallel investigation and isolated implementation should remain possible. Nothing here grants automatic merge authority, selects a new runtime or transcript store, or claims that current tangent and worker controls already provide continuous delivery.

## Cockpit purposes

The User described four panel purposes from the v0 Cockpit. Preserve the purposes separately from its old role names, mandatory phases or DAG.

| Surface                 | Purpose                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Context tree            | Proactive orientation across projects and owners, navigation and starting work                                                  |
| Selected-owner overview | Detail about the selected owner's efforts; it could become thread/effort detail rather than an obligatory Plan/Workflow/Job DAG |
| Inbox                   | Reactive, hierarchically owned requests for the User's attention, with navigation to the responsible owner                      |
| Chat                    | The interaction surface at project or focused-work level                                                                        |

Ownership, statuses and counts help visibility; they are not steps agents must ceremonially record. The Inbox should distinguish a User action from background activity, and dismissing an item from resolving the underlying need. The User subsequently selected the [navigator ownership and attention vocabulary](#navigator-ownership-and-attention); this does not select a universal status enum or Inbox implementation.

External observation of artifacts/activity is a hypothesis, not an approved classifier architecture:

- A worktree does not prove dispatch.
- Dirty Git state does not prove current activity.
- An open PR does not prove accepted delivery.

Observations, freshness and unknowns should remain honest rather than becoming invented certainty.

## Navigator ownership and attention

On 2026-11-25 the User selected a two-axis status direction for the **left chat navigator**. This section records the intended experience and follow-up design work, not an implemented feature. A later adaptation to the conversation map, especially message threads, is possible but its layout and behavior are not selected yet. This is not a global attention Inbox or a new agent runtime.

A single icon combines **whose turn it is** (shape/motion) with **the kind and priority of attention** (color). The actor may be the agent, the user, or a future participant; color does not determine the actor. Apply attention colors only to the icon, not the chat title or entire row. Use the existing neutral white/grey treatment by default to avoid attracting attention unnecessarily. Status must also be available as text and icons, not color alone; supply accessible names and a non-motion equivalent when reduced motion is requested.

### Ownership: shape and motion

| Appearance                      | Meaning                                                                                             |
| ------------------------------- | --------------------------------------------------------------------------------------------------- |
| Hollow/empty circle             | The agent is idle and the user has read its messages.                                               |
| Animated rotating dotted circle | The agent is busy/running; it is the agent's turn.                                                  |
| Filled circle                   | It is the user's turn: the agent is idle or waiting for the user to read its reply or do something. |

These shapes are the selected intent, not proof that the system can currently establish every condition. In particular, idle by itself neither proves the user read a reply nor proves work is complete. How to represent unknown or stale ownership, or a situation in which multiple actors have concurrent next actions, remains open; do not silently classify unknown as read or idle.

### Status: icon color and attention priority

The User's requested ordering from highest to lowest attention is:

| Priority | Icon color | Category | Meaning for the actor                                                                                                                                                    |
| -------- | ---------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1        | Red        | Blocker  | Highest attention: the actor must act to unblock work execution; failures, emergencies and incidents are examples.                                                       |
| 2        | Yellow     | Delivery | Work is done but awaits release, merge, deployment, PR creation or another delivery action. Done work becomes valuable when it reaches its customer.                     |
| 3        | Magenta    | Decision | Work is paused for an unclear requirement, question, confirmation, authorization or other decision.                                                                      |
| 4        | Cyan       | Support  | External help is required or being given, such as a peer PR review or a Slack reply. This category is documented for future work; it is not currently supported.         |
| 5        | White      | Default  | Everything else is proceeding as expected: no urgent attention or action is required, or the actor can look when nothing more important is pending.                      |
| 6        | Grey       | Disabled | Something is unavailable, for example an archived chat. This category is documented for future work; the proposed disabled-status semantics are not currently supported. |

These are meanings and relative priorities, not a promise to infer a status from a keyword or automatically sort the navigator. How to choose among simultaneous categories, and how disabled interacts with attention or stale information, remains to be designed. Archived chats exist today; that does not mean the proposed grey indicator is implemented.

The axes must remain independent. For example, **red + rotating dotted** means the agent owns the turn and is working to unblock itself, perhaps by researching prior decisions, researching online, or resolving a rebase conflict. **Red + filled** means the user's action is needed for the blocker. A **magenta filled** icon can indicate a user decision; a **yellow filled** icon can indicate a user-owned delivery action, while **yellow + rotating dotted** can indicate the agent is performing delivery. A white filled circle can indicate an unread reply; a white hollow circle indicates idle and read. These examples describe intended meaning, not automatic classification rules or evidence that a given task is complete.

### Current evidence and limitations

At the base inspected for this design, the sidebar catalog exposes a per-chat `running` boolean and the existing sidebar renders a running spinner. It does not expose the two-axis vocabulary, a reliable per-chat read state, or a delivery/support classification. The selected chat's thread index reports `running`, `waiting`, `idle`, `interrupted` or `failed`; its `waiting` currently covers both a running `ask_user` tool and a nonempty inbox. Therefore `waiting` is not by itself evidence that the user must make a decision. A failed thread-index refresh retains the last list, and stale observations must not be presented as current facts. See [implemented chat and thread behavior](chat-components.md#message-threads).

A saved reply, idle agent, admission receipt, local Git state, open PR, merge and deployment establish different facts. None alone should be promoted to read, completed, delivered or accepted. A disconnect means observation is unavailable, not that the agent stopped. A user viewing a chat is not automatically proof they read a particular reply until a read/acknowledgment contract is chosen. Cancellation/interruption is not automatically an urgent blocker. Pending queued input is not automatically a question or a user-owned action.

### Follow-up plan and open decisions

This is a proposed sequence for later work, not authorization to implement a specific schema or restart the host. The User has requested documentation and a PR now; feature implementation is follow-up work:

1. **Specify the state contract.** Decide the authoritative facts, their source and freshness; who or what may set, update, clear or override each status; and how to distinguish observed state from an agent/user declaration. Define category priority when facts coexist and a truthful unknown/stale presentation. Separate execution, actual questions, inbox input, read state, lifecycle and delivery evidence rather than flattening them into one unqualified status.
2. **Define read and ownership transitions.** Decide what constitutes read/acknowledged, its scope across chats, threads, browser sessions and devices, how new replies or simultaneous activity interact, and whether marking read is automatic or explicit. Specify behavior during reconnection, retries and concurrent changes. Do not conflate reading with acceptance, task completion or authorization.
3. **Define delivery and support evidence.** Decide when an agent or user can declare a blocker, decision, delivery or support need, how that declaration is resolved, and how concrete artifacts and verification are linked. PR creation, merge and deployment are distinct. Support and disabled categories remain future states until their semantics and sources are agreed.
4. **Design the projection before the presentation.** Inspect pi-durable's existing live/task/question APIs and the catalog/thread projections; retain pi-durable as execution and transcript authority. A navigator spanning chats needs scoped, bounded and freshness-aware observations for those chats, not the selected conversation's local state misapplied globally. Choose polling/subscription, data ownership, persistence and migration deliberately; no second runtime or universal ledger is selected.
5. **Implement navigator presentation after contracts are agreed.** Reuse supplied assistant-ui elements, respecting the [component priority](#minimal-runtime-slice), keyboard and screen-reader access, non-color cues, reduced motion and narrow layouts. Preserve ordinary navigation; viewing or inspecting status must not start, stop or submit work. The conversation-map/thread adaptation is a later design step, including how to handle multiple source threads in one turn and unloaded history.
6. **Verify before claiming delivery.** Cover independently varying ownership/color, all supported categories and priorities, real user questions versus queued input, read/unread transitions, simultaneous events, failures versus interruptions, archived/disabled behavior when supported, unknown/stale/disconnected observations, accessibility and reduced motion. Exercise navigation, focus, reconnect/reload and race conditions without starting paid requests. Attribute checks to the tested head/base; a PR, merge and deployed host are separate outcomes.

## Verification experiment

One main thread, two tangents and workers finishing out of order exercise the selected design: the User can keep discussing intent, enter either tangent, send changed decisions and answer a visible request for input. Results return with evidence and explicit handoffs without flooding the main context with execution transcripts. Verification must include independent drafts and Stop scope, reopening, duplicate admission, stale responses and context changes during work.

This experiment is within the 2026-11-18 implementation authorization. It does not establish completed implementation or authorize a scheduler, Ledger, automatic helper spawning, legacy migration or public exposure.

## Decision provenance

The fresh baseline, parallelism clarification, Cockpit purposes and earlier living-brief discussion come from the User's 2026-11-16–17 decisions. Main threads, tangents, workers, handoffs, model-tier defaults and the TaskCard/AgentStatus selection were settled in the 2026-11-18 conversation, followed by explicit implementation authorization. The navigator ownership/attention direction records the User's 2026-11-25 explanation; its data contracts and implementation remain open. These sections state their substance so reading local records is not required. The [historical sources](problem-and-learning.md#historical-sources-and-interpretation) support the earlier lessons; they are not evidence that the fresh design is already operating.
