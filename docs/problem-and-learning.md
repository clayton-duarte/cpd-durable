# Problem and learning

## The need

The User works on several large projects at once. A harness with a few isolated chats is not enough: parallel efforts must remain understandable, affordable and steerable without repeated grounding or continuous manual coordination.

CPD needs to support:

- Continuity of intent, decisions, evidence and relevant project knowledge across conversations and interruptions.
- Bounded ownership, so delegating work does not leave two agents executing the same outcome.
- Nonblocking project discussion while investigation or delivery proceeds elsewhere.
- Isolation of tangents without losing relevant grounding or making the User relay messages.
- At-a-glance orientation across projects and clear requests for human attention.
- Evidence of delivery and a usable way to resume, cancel or recover when work stalls.

These needs motivate the [current design direction](design.md); they do not select every mechanism needed to meet them.

## What the User learned

The following history is the User's account, recorded on 2026-11-17. It is not an independent benchmark of models or products.

| Approach                                        | Value experienced                                                                          | Cost or unresolved need                                                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| One frontier-model “super soldier” conversation | Planning and execution in one place                                                        | High execution cost, repeated grounding for new tickets, and overloaded context and coordination across a larger project             |
| Architect/builder                               | A frontier model planned while a lower-cost helper implemented, dramatically reducing cost | The architect could be blocked waiting; weak handoffs allowed scope creep or stalls; continuity and parallel work remained difficult |
| Hermes Kanban                                   | Cards and workers improved parallel execution                                              | Nine states added cognitive burden; review was not always useful; triage or blocked work could lack a clear intervention owner       |
| Forked conversations                            | Tangents could leave the main chat                                                         | Excess context copying, duplicate parent execution, unclear ownership/status and manual coordination by the User                     |
| CPD v0                                          | Valuable experimentation with continuity, ownership and delivery controls                  | Accumulated machinery overcomplicated the solution; the original problem remained                                                    |

V0 was not a total failure. Its useful lessons and evidence should survive without giving its mechanisms a presumption of necessity.

## Lessons for this reset

The User accepted delivery refinements on 2026-11-16: enforce authority, authorized scope, evidence and real dependencies rather than one execution choreography. Approval concerns that delivery contract, not an equivalent rearrangement of work. Keep cohesive work together unless independence, verification, permissions or size justify a split.

Evidence should match the assignment. A stopped agent, test result, commit, merged PR and deployment establish different facts. Recovery must have a responsible actor and an available next action; it cannot fabricate success or depend on the blocked condition being resolved first.

One accepted v0 observation was that procedural compliance displaced delivery: repeated discovery, draft/review churn and an unjustified serial documentation chain added overhead. The initiating brief contributed to that overhead too. This is evidence about that execution, not a diagnosis of every runtime behavior or the quality of all resulting artifacts.

Durable, attributable knowledge remains valuable. That does not establish a need for a universal operational Ledger, scheduler or state machine.

## Parallel implementation is not continuous delivery

During this repository's 2026-11-18 feature delivery, agents implemented several features on separate branches and worktrees from a shared baseline. Many independently edited the same integration surfaces: native chat/composer wiring, server admission and startup, shared projections, browser fixtures and capability documentation. After the User merged individual PRs, other open PRs repeatedly conflicted. Refreshing every remaining branch after each merge repeated reconciliation and verification work and made the User request conflict repair several times.

The evidence is this repository's PR and merge history, including [model settings #30](https://github.com/clayton-duarte/cpd-durable/pull/30), [prompt templates #32](https://github.com/clayton-duarte/cpd-durable/pull/32), [edit receipts #38](https://github.com/clayton-duarte/cpd-durable/pull/38), and the overlapping [thread integration #40](https://github.com/clayton-duarte/cpd-durable/pull/40), plus the User's reports and agent verification returns. This is an observed coordination failure, not a measured comparison of delivery strategies. Green checks and mergeability described a particular head and base; they did not establish compatibility with subsequent merges.

Separate worktrees isolated working files, not shared design, integration ownership or future merge effects. The supervisor launched overlapping integration work and reacted with repeated all-PR refreshes rather than managing dependencies and a bounded landing queue. The lesson is not to eliminate parallel work: CPD should enable **continuous parallel delivery**, not merely concurrent implementation followed by a reconciliation bottleneck.

Prevention starts before dispatch: identify shared integration surfaces and dependencies, give each surface an integration owner, and delegate isolated modules and tests against explicit contracts. Land enabling interfaces before dependent integrations, or represent genuine dependencies explicitly rather than treating every branch as independent. Keep cohesive features together; do not turn these lessons into an obligatory architect/builder hierarchy or a new procedural ledger.

For the current backlog, the User selected PR creation order as the landing queue. Refresh and verify the next PR against the actual merged base, let the User review and merge it, then advance the queue. Do not refresh every later branch merely to keep its mergeability indicator green. This is the present recovery policy, not a universal requirement to serialize implementation or use creation order forever.

The [product implications](design.md#continuous-parallel-delivery) distinguish the selected problem from mechanisms still to be designed.

## Historical sources and interpretation

Historical source links may require access to the original repository; making this repository public does not publish those sources.

- [Original essence analysis](https://github.com/clayton-duarte/cpd/blob/5f17731283b891c98e1408d9b3dbc0801585d3da/docs/essence.md): User-approved historical text, left verbatim at its existing source.
- [Accepted delivery principles](https://github.com/clayton-duarte/cpd/blob/5f17731283b891c98e1408d9b3dbc0801585d3da/docs/delivery-principles.md): the refinements and execution observations summarized above.

Both sources are pinned to the old repository's merged documentation commit. They are provenance, not a requirement to inherit its runtime or role hierarchy. Later User decisions on 2026-11-17 explicitly made parallelism central and reopened topology; those decisions govern the [design baseline and proposals](design.md). In particular, the original analysis's framing of parallelism as incidental is historical, not current direction.
