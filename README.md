# CPD Durable

CPD exists to make parallel work across several large projects understandable and manageable. It should preserve intent and continuity, make ownership and progress visible, and focus human attention where judgment is needed—without requiring the human to supervise every execution step.

Parallelism is the reason for CPD, not a worker-count target. Pragmatism guides the approach: keep cohesive work together and add coordination only when it earns its cost.

## Current status

This fresh start, framed as CPD v1, now includes a minimal localhost browser chat backed directly by one persistent pi-durable conversation. It is an initial connectivity/persistence slice—not the multi-project Cockpit, a legacy migration or an application cutover.

The existing [CPD repository](https://github.com/clayton-duarte/cpd) remains historical reference; its identity is unchanged. Starting fresh does not authorize deleting its data or evidence.

## Run locally

Use pnpm (the package manifest pins its version). Install dependencies from the repository root:

```sh
pnpm install --frozen-lockfile
cp .env.example .env
```

Set `OPENCODE_API_KEY` in your local `.env` or inject it into the server environment from your secret manager, then:

```sh
pnpm dev
```

Open **http://127.0.0.1:5173**. Vite+ serves React and proxies `/api` to Hono on loopback port 3000. Both ports must be available. pnpm provisions the pinned Node LTS through `devEngines.runtime`; `.node-version` records the same version for other runtime managers. The project-local Vite+ CLI is available as `pnpm exec vp`.

Use this live development mode while iterating: client edits hot-reload and server edits restart the watched server. Keep the same `CPD_DATA_DIR` across worktrees to preserve the active conversation. When injecting credentials from a secret manager, run `pnpm exec vp dev` separately and inject credentials only into `pnpm exec tsx watch src/server/index.ts`, rather than the frontend process. These separate commands provide the same live-reload loop.

For the built frontend, stop the development processes first:

```sh
pnpm build
pnpm start
```

Open **http://127.0.0.1:3000**. Start from the repository root. A missing API key fails startup without opening the session.

The model is fixed to OpenCode Go's `deepseek-v4.1-flash`, using pi-ai's native `opencode-go` provider (not OpenCode Zen or OpenRouter). The SDK sends its stable per-conversation session header and the application identifies itself as CPD Durable. There are no tools, attachments, model selector, new-chat/reset control or LAN access. Send is disabled while busy; Stop explicitly aborts the response. Responses are rendered as plain text, not interpreted HTML. The stock shadcn dark theme is the default from initial page load, independent of system preference; no theme picker or custom palette is added.

## Persistence and recovery

pi-durable's Node SQLite adapter owns the transcript and execution state in `data/session.sqlite` by default (`CPD_DATA_DIR` can change the directory). Browser refresh/reconnect reconstructs the latest view through SSE; the browser does not persist a transcript. The UI shows the SDK's recent-message window and labels omitted earlier history, which stays in storage.

The server opens one Harness and resumes pending SDK work. A disconnect detaches observation, not execution. SDK request IDs deduplicate a retried submission; the client retains its retry ID only until refresh. After an ambiguous send followed by refresh, check the restored conversation before resending. Durability is not a guarantee of uninterrupted token streaming: the SDK can retry interrupted provider requests, and its documented progress-persistence window may lose recent partial output on a crash.

Run only one application host against a data directory. The fixed loopback listener is acquired before writable storage opens, so a second application host fails without touching it. To restart, stop the existing host and start again with the same data directory. Do not edit or delete SQLite/sidecar files to resolve an error. Session-open failures leave existing data in place for inspection.

## Public repository and private runtime data

This repository is public; its package remains marked private to prevent accidental npm publication. Keep `.env`, credentials, database files, conversations, logs and browser traces out of commits. The ignore rules cover default local artifacts, but are not a substitute for reviewing a change. Keep any custom data directory outside tracked source.

Provider credentials are server-only. Requests go to OpenCode Go and the selected model provider; conversation storage contains sensitive input/output. Protect that directory and any backups accordingly. The server applies an owner-only creation mask. API responses expose a small presentation schema, not raw SDK documents or provider diagnostics. Consult [OpenCode Go's privacy settings](https://opencode.ai/docs/go/#privacy); access to DeepSeek may require the workspace to allow Global regions. The application does not change those settings.

The server binds to loopback and rejects foreign hosts/origins; it is not an authenticated service. Do not expose it through a LAN bind, tunnel, reverse proxy or public host without a separate access-control decision.

## Checks

```sh
pnpm check
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:browser
```

`pnpm check` runs Vite+ formatting, type-aware lint and type checks, plus separate strictest client/server/tool TypeScript configurations. Client/shared imports are restricted from Node and SDK/server modules. `pnpm-workspace.yaml` holds pnpm tool policies only; this is a single package, not a workspace monorepo.

The Actions workflow runs separate `tsc`, `lint`, `fmt` and `test` jobs on PRs and pushes to `main`, using standard GitHub-hosted `ubuntu-latest` runners. These are the required checks for protected `main`; its protection also requires a PR and an up-to-date branch, applies to administrators, and blocks force-pushes/deletion. Build and browser checks above are additional local verification, not part of these four required jobs.

All external contributors require workflow approval in repository settings. Review workflow changes before approval; CI uses a read-only token and needs no provider credentials.

Integration tests use the real SDK and SQLite with a controllable test provider. Browser tests exercise the built frontend through Hono/SSE and the real SDK, substituting only the provider. They do not establish that a live OpenCode Go credential/request succeeds. These checks need no provider secrets. Browser traces may contain conversation text; local tests use synthetic data only.

## Read next

- [Problem and learning](docs/problem-and-learning.md): the needs and experiences behind the reset.
- [Design direction](docs/design.md): settled baseline, proposals and unresolved questions.
- [pi-durable feature inventory](docs/pi-durable-features.md): SDK capabilities, current chat coverage and possible enrichment choices.
- [Documentation conventions](docs/CONTRIBUTING.md): where material belongs and how to maintain it.
- [Agent entrypoint](AGENTS.md): scoped instructions for agents changing this repository.
