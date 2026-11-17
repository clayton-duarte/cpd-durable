# Documentation conventions

Keep a small foundation that helps readers understand the project and agents act within its actual scope. Add a document only when it serves a distinct need that existing material cannot serve clearly.

## Audience and authoritative home

| Home | Primary purpose |
| --- | --- |
| [README](../README.md) | Human introduction, actual repository status and navigation |
| [Problem and learning](problem-and-learning.md) | Needs, attributed history and historical source references |
| [Design](design.md) | Settled direction, proposals and open questions |
| [AGENTS.md](../AGENTS.md) | Actionable, repository-specific instructions for agents making changes |
| This document | Documentation placement and maintenance conventions |

Primary purpose determines audience—not prose versus tables. Agents may need rationale, definitions, recovery guidance or questions; humans may need commands and reference material. Link to relevant material rather than creating parallel human and agent copies.

Each fact or decision has one authoritative home. Entry points summarize only enough to orient readers and point there. Keep agent pointers conditional on the work that needs the material; avoid making all historical context an obligatory load.

## Maintaining a change

The author updates the authoritative home and affected navigation together. Record whether a statement is a settled decision, proposal, unresolved question or verified implementation fact, with source/date when material to interpretation. Do not promote a hypothesis into a requirement or an open question into an implementation commitment.

Current guidance should be readable without reconstructing historical amendments. Preserve attribution and evidence limits when summarizing history. Keep the original approved essence analysis unchanged at its [pinned source](problem-and-learning.md#historical-sources-and-interpretation); if copying it ever becomes necessary, preserve its bytes verbatim and place later refinements separately.

Before proposing a change, read every changed document for its audience, accuracy, provenance and unnecessary repetition. Check affected relative links and anchors, and ensure repository prose contains no private machine paths or credentials. Report the checks actually performed and their limits. Do not invent build/test commands or an exact-prose test framework for this documentation-only repository.

Audience separation, scoped reading and single-source maintenance adapt ideas from the User's older [homeserver documentation guidelines](https://github.com/clayton-duarte/homeserver/blob/main/docs/CONTRIBUTING.md). That reference is not governing policy here: its Copilot conventions, arbitrary size threshold, strict content-type exclusions and prescribed backlog shape are not adopted.
