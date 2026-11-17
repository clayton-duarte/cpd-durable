# Working in this repository

- The current implementation scope is a single localhost, text-only browser chat backed by pi-durable. Additional runtime capabilities and legacy migration require separate authorization.
- This repository is public. Keep provider credentials server-side; never commit secrets, machine-local paths, conversation data, logs or database files. Review staged changes and built client assets for accidental exposure.
- Before changing content, read [documentation conventions](docs/CONTRIBUTING.md). For product claims, consult [design direction](docs/design.md); for historical claims, consult [problem and learning](docs/problem-and-learning.md).
- Author changes on a branch in a separate worktree; leave the primary checkout untouched. Check for overlapping ownership before editing. This repository does not require CPD v0 dispatch machinery.
- Follow the conventions' content/link review guidance and report actual evidence. Distinguish commit, PR, merge and deployment; creating a PR grants no merge authority.
