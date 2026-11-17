# Design direction

This document records the User's settled fresh-start decisions and still-open discussion as of 2026-11-17. “Settled” means selected direction, not implemented behavior. See the [repository status](../README.md#current-status) and [problem and learning](problem-and-learning.md) for context.

## Settled baseline

Methodology comes first; the platform enables it. Skills carry the methodology. The platform remains necessary for model access, interaction, approvals and human control; methodology-first does not mean tooling-free.

- New CPD tooling is full TypeScript; no Rust-retention carve-out was selected.
- WebUI/Cockpit and upstream pi-durable are the only retained platform foundations. Cockpit is the target human control interface.
- pi-agent+tmux and the TUI are dropped from the target; their removal from the legacy runtime is not claimed.
- No previous machinery is inherited by default. A capability must first be genuinely missed and justify adoption. This applies to the Ledger, scheduler, CLI, state machine, adapters, durable-host wrappers, guards, integrations and tests.
- Preserving decisions, data and evidence is separate from retaining their machinery. The reset is not permission to delete legacy data.

The existing WebUI and durable wrappers still depend on the old CPD CLI and Context/Plan/session contracts. They are not independent drop-in modules. Retaining their foundation is a direction, not proof that copying them produces the target platform.

The accepted [delivery lessons](problem-and-learning.md#lessons-for-this-reset) govern future mechanisms: preserve intent, bounded authority, real dependencies, outcome evidence, usable recovery and human control without prescribing every legitimate execution strategy.

## Minimal runtime slice

After the documentation foundation, the User authorized one browser chat backed by one pi-durable session, deliberately deferring multi-project orchestration.

Selected stack: Vite+, pnpm, React, TanStack Router, uncustomized shadcn/AI Elements patterns, Hono, Zod and `@tsconfig/strictest`. Use current compatible releases and lock them; the SDK's experimental API makes version alignment important.

One package contains `src/client`, `src/server` and browser-safe `src/shared` modules. Package extraction is deferred until independent consumers, deployments or dependency isolation justify it. Zod validates application boundaries, without replacing the SDK's internal schema mechanisms.

The initial implementation is localhost-only and text-only, with OpenCode Go's `deepseek-v4.1-flash` fixed server-side. The User clarified that the earlier OpenRouter reference was a misstatement; OpenCode Go is the intended provider. Hono relays validated input and SDK conversation watches over SSE (`streamSSE`); the SDK owns execution, retries and SQLite persistence. Browser state is transient. There is no separate transcript database, legacy wrapper, tool registry population or orchestration service.

This slice implements send/stream/stop, recent history, reconnect and reopen/resume. [Running instructions and verification boundaries](../README.md#checks) distinguish local tests with a substituted provider from live-provider verification. LAN access, additional models, tools and broader topology remain outside this slice.

## Proposal: project conversations and interactive threads

A stable project conversation could develop intent and explore vague ideas. Short-lived interactive threads could own bounded tangents worth separating for model cost, context or direct User interaction: research, implementation or another focused effort. An investigation can be a bounded outcome; a thread need not be an implementation task.

The thread owner could investigate and execute directly, using helpers when useful. The project conversation could also use helpers. This is not a selected Manager → Lead → Worker hierarchy. Names and the relationship between a helper and an interactive thread remain open.

The intended benefit is an available project-level conversation while focused work proceeds independently. Ownership transfer must avoid parent and thread executing the same delegated outcome. Real dependencies and overlapping edits still require coordination; the User should not become the message bus.

### Proposal: a living thread brief

The User proposed a living `thread-<slug>.md`, updated by the project agent and read by the execution agent. It could hold selected relevant grounding rather than clone a full transcript.

Unresolved mechanics include:

- How changes reach an active thread, and how anyone knows it actually read them.
- How stale assumptions are detected and handled.
- When updates are safe while work is running.
- Who can authorize a scope change and what requires renewed agreement.

A changed file is not proof that a running model read it, and a brief update is not implicit authority to expand scope. Shared grounding is not live shared model memory. No watcher, acknowledgement state machine, directory schema or memory platform is selected by this proposal.

### Other open questions

- What context and evidence are sufficient for each bounded handoff?
- How do messages and results reach the accountable owner without blocking the project conversation or requiring manual relaying?
- What distinguishes cancellation, failure and successful delivery, and where is each assignment's completion boundary?
- How should durable project knowledge stay useful as the main conversation grows?
- How should unpursued ideas be organized without turning every thought into a task or thread?
- How should ownership, activity, freshness and need for human attention be shown across many projects?

These questions are not a committed backlog. An earlier minimum-migration proposal is not the immediate execution agenda; documentation and clarification come first.

## Cockpit purposes

The User described four panel purposes from the v0 Cockpit. Preserve the purposes separately from its old role names, mandatory phases or DAG.

| Surface                 | Purpose                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Context tree            | Proactive orientation across projects and owners, navigation and starting work                                                  |
| Selected-owner overview | Detail about the selected owner's efforts; it could become thread/effort detail rather than an obligatory Plan/Workflow/Job DAG |
| Inbox                   | Reactive, hierarchically owned requests for the User's attention, with navigation to the responsible owner                      |
| Chat                    | The interaction surface at project or focused-work level                                                                        |

Ownership, statuses and counts help visibility; they are not steps agents must ceremonially record. The Inbox should distinguish a User action from background activity, and dismissing an item from resolving the underlying need. No replacement palette or status enum is settled.

External observation of artifacts/activity is a hypothesis, not an approved classifier architecture:

- A worktree does not prove dispatch.
- Dirty Git state does not prove current activity.
- An open PR does not prove accepted delivery.

Observations, freshness and unknowns should remain honest rather than becoming invented certainty.

## Possible experiment, not authorized implementation

One project conversation, one direct-execution thread and one independent tangent could test the proposal: the User can keep discussing intent, enter either thread, route changed decisions and answer a visible request for input. Results would return with relevant evidence and durable knowledge without flooding the project conversation with execution transcripts. Cross-project navigation would also need examination.

This example does not select a scheduler, Ledger, fixed hierarchy or mandatory helper spawning. No runtime experiment, migration or cutover is implemented or authorized by this documentation foundation.

## Decision provenance

The fresh baseline, parallelism clarification, Cockpit purposes and living-brief discussion come from the User's 2026-11-16–17 decisions, preserved in the standalone continuation handoff. These sections state their substance so reading local records is not required. The [historical sources](problem-and-learning.md#historical-sources-and-interpretation) support the earlier lessons; they are not evidence that the fresh design is already operating.
