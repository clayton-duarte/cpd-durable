# cpd

CPD exists to make parallel work across several large projects understandable and manageable. It should preserve intent and continuity, make ownership and progress visible, and focus human attention where judgment is needed—without requiring the human to supervise every execution step.

Parallelism is the reason for CPD, not a worker-count target. Pragmatism guides the approach: keep cohesive work together and add coordination only when it earns its cost.

## Current status

This fresh start, framed as CPD v1, now includes localhost browser chats backed directly by persistent pi-durable conversations, with a sidebar for creation and navigation. It is not the multi-project Cockpit, a legacy migration or an application cutover.

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

**Settings** assigns main, tangent and worker model/thinking defaults from the server's authenticated catalog. A genuinely new main chat uses the configured main assignment; until configured it uses the host default, OpenCode Go's `deepseek-v4.1-flash`. Reusing an existing empty chat does not reconfigure it. Tangents and workers require their configured assignments; unavailable assignments do not silently fall back. The role labels express intent, not guaranteed model capability. **Chat details** independently offers a per-chat picker; Save persists across reopen and applies to subsequent requests. It also exposes SDK usage/recovery, committed context boundaries and manual compaction; occupancy/headroom remain unknown. See [context, configuration and usage](docs/chat-components.md#4-context-configuration-and-usage) for scope and retry limits.

Chat uses assistant-ui's external-store runtime, native thread/message/composer primitives and Markdown renderer; pi-durable remains authoritative through Hono/SSE. Host tools include **read, write, edit, bash, powershell, grep, find and ls**. Calls, streaming output, results and failures appear in supplied tool disclosures. PowerShell needs `pwsh` or `powershell` installed; grep/find need host `rg` (ripgrep), while ls uses the SDK directory reader. Search-tool output limits are not command deadlines or filesystem boundaries; see [tool semantics](docs/chat-components.md#3-agent-activity-tools-and-tasks). Assistant Cloud and LAN access remain unimplemented. User text stays literal; assistant Markdown supports lists, tables and copyable code, without executing rendered code/raw HTML or fetching remote Markdown images. The existing dark theme remains the default.

Use **Add Attachment** or paste to attach PNG/JPEG images, alone or with text, when the selected server-resolved model supports image input. Up to four images are accepted, each at most 5 MiB, 8,192 pixels per dimension and 32 million pixels. The SDK decodes and prepares images to at most 2,000×2,000 pixels and 4,500,000 base64 bytes for the model; saved user and tool PNG/JPEG images render through authorized same-origin references. Other file ingestion is not supported. Originals are retained in the data directory, including removed or unreferenced uploads; prepared model content is retained in SDK history. Neither chat deletion nor draft removal automatically deletes those bytes.

Use **New chat** in the supplied assistant-ui sidebar. It reuses the existing empty chat rather than creating duplicates. TanStack Router gives each chat a `/chats/<id>` deep link, back/forward navigation and mobile sidebar navigation. Existing history appears as **Original chat**; new chats receive a title from their first admitted input. Switching retains visited chats' native drafts and retry state until refresh and never stops background work. Each chat's context menu (ellipsis, right-click or Shift+F10) offers **Rename**, **Archive** and **Delete**; archived chats can be viewed/restored under **Archived chats**. Delete removes a chat from the app, not its underlying SDK records. Committed-message **Fork from saved entry** creates an independent durable branch at that inclusive cutoff; header branch controls and Open source chat navigate saved conversations without sharing drafts or replaying work. See [chat navigation semantics](docs/chat-components.md#chat-navigation-and-creation).

Main chats show their immediate tangents and workers above the conversation. Select a tangent to open its independent chat beside the main chat; on narrow screens use the pane tabs. Closing is navigation, not Stop or conclusion. Write a goal and select **`/tangent`** (or **`/side`**) to request that the main agent prepare a handoff and use the creation tool; the request does not guarantee the model calls it. A create-only tangent requires an explicit **Start tangent** with its stored handoff before ordinary input. See [interactive threads](docs/chat-components.md#interactive-tangents-and-workers) for lifecycle, return review and delivery limits.

**Execution defaults to your home directory (`~/`)**, independently of the repository and session-data location. `CPD_CWD` overrides it and expands `~`/`~/…`. This is not a sandbox: tools can access absolute paths, parent directories, network programs and the server account's inherited environment with normal OS permissions. There are no cpd approval prompts, path/command restrictions, forced shell timeouts or tool-round caps. Commands can modify/delete files and expose account secrets in tool output; protect the local host and conversation data accordingly. Shell `cd` affects that invocation, not the default directory of later calls. See [pi TUI parity and remaining work](docs/pi-durable-features.md#pi-tui-parity); native tools alone are not full TUI parity.

The SDK's `codemode` tool can call installed native tools through journaled nested calls. Its QuickJS execution does not sandbox those tools' host permissions. Model and image generation globals are disabled; MCP is not yet integrated.

### Project guidance and skills

For each provider request the server discovers `AGENTS.md` along the conversation's actual cwd ancestry, from filesystem root toward the nearest directory. The cwd defaults as described above; symlinks are resolved to the actual directory. It also looks one level deep under `.pi/skills/<directory>/SKILL.md` at each ancestor, nearest first. The first valid skill with a given name wins. The model receives file provenance and bounded skill name/description metadata, and can call `load_skill` to read a discovered skill's current file on demand. A skill body is not automatically included or executed.

Skill frontmatter currently supports only scalar `name` and `description` values in plain, JSON-double-quoted or YAML-single-quoted form, not general YAML. Additional fields are ignored and reported; unsupported required-field forms and conflicting names are reported and excluded. Missing files are skipped; unreadable or non-regular files are reported. Regular-file symlinks are followed, but FIFOs and other special files are rejected. Discovery reads only conventional locations, not arbitrary home-directory files; it does not install packages or run setup commands.

Discovery is bounded to 128 nearest ancestors, 200 entries per directory, 1,000 selected entries overall, and 32 KiB per file. Over-limit directory subsets depend on filesystem enumeration order; selected entries are processed in sorted order, with omissions reported. The complete resource prompt section is capped at 64 KiB including paths and omission counts, preferring nearest instructions. Issues and omission counts appear in that section, not in a dedicated browser inspector. The SDK may also apply tool-output limits. Local files and their paths can be sent to the selected provider and skill tool output can enter private conversation history.

The SDK transports this local project/user guidance in its **system prompt**. Its provenance notice is not API-role isolation or a security boundary. A request uses its prepared prompt; editing a file does not prove an in-flight request read the change. The next request prepares a fresh section; `load_skill` rediscovers and reads at tool invocation, so it can see later changes. Immediate `.md` files under ancestor `.pi/prompts` directories are discovered as data, nearest name first, but no user-facing selection/submission flow exists. Up to 32 extra skill roots and 32 extra prompt roots can be supplied to the server resource adapter (resolved against cwd); these are not exposed as host settings; configured extension/package loading is also unimplemented.

The official assistant-ui Thread supplies the runtime composer, messages and actions. Native **Send** submits while idle. **Type `/` in the composer** for available commands: `/queue` sends the current draft after the response, `/steer` applies it at an eligible boundary, and `/continue` requests an answer from unresolved active context without sending the draft. For queue/steer, write the draft first, append the command and select it from the list; this is an action picker, not a `/command arguments` parser. Commands disappear when unavailable; reserved command text/prefixes are never silently sent as ordinary input. Queued inputs are visible below the composer with individual withdrawal buttons. Native **Stop** aborts foreground work and withdraws queued inputs.

When the assistant needs structured input, its `ask_user` tool can show a question above the composer. Answer or decline it without consuming the chat draft; this is a request for information, not tool approval. A disconnect is not a decline. An unconfirmed answer can be retried with the same question identity, revision and values, or refreshed before choosing another response. See [question semantics and limits](docs/chat-components.md#structured-agent-questions).

Select **`/reset`** for a compact confirmation dialog with optional multiline handoff and **Cancel / Reset context** actions. Stored history remains; only active model context restarts. While busy, reset waits for a boundary. Stop does not withdraw a queued reset. Handoff text becomes a user message; reset alone does not request an answer. The idle Ready pill, nested ellipsis/palette and unavailable Refresh control are omitted. See the [component mapping and semantics](docs/chat-components.md#2-composer-and-run-controls) for reuse and pending work.

## Persistence and recovery

pi-durable's Node SQLite adapter owns the transcript and execution state in `data/session.sqlite` by default (`CPD_DATA_DIR` can change the directory). The UI starts with a recent window and offers **Load earlier messages** in 50-entry pages. SDK transcript merging retains loaded history across reconnects and exposes **Load missing messages** for gaps; reading/retrying history never resends a message. The browser does not persist a transcript. See [history semantics and cache/restart limits](docs/chat-components.md#complete-history-access-batch-3).

In **Chat details**, **Search or export saved history** scans the current chat, chosen chats or the catalog; archived chats require explicit inclusion and deleted chats are excluded. Search covers saved user/assistant text, not reasoning or tool/image content. Downloads are logical Markdown/JSON, not restorable backups; scans have caps and independently frozen chat boundaries. See [saved-history scope and limits](docs/chat-components.md#saved-history-search-and-logical-export).

The server opens one Harness and resumes pending SDK work. A disconnect detaches observation, not execution. SDK request IDs deduplicate retried input, Continue and reset admissions; the client retains retry identity only until refresh. While delivery is uncertain, retry the original action before another mutation; a newer composer draft remains editable and is not consumed by retrying a control. After an ambiguous action followed by refresh, inspect the restored state before repeating it. Durability is not a guarantee of uninterrupted token streaming: the SDK can retry interrupted provider requests, and its documented progress-persistence window may lose recent partial output on a crash.

Requests admitted before the host recorded request fingerprints cannot be verified against a retry payload; retrying one of those legacy request IDs returns 409, including an identical payload. Inspect saved state rather than assuming it was not admitted.

Stop targets current work rather than a request ID. If Stop cannot be confirmed, inspect current state before explicitly stopping again; the UI does not offer it as a supposedly safe original-action retry.

Run only one application host against a data directory. The fixed loopback listener is acquired before writable storage opens, so a second application host fails without touching it. To restart, stop the existing host and start again with the same data directory. Do not edit or delete SQLite/sidecar files to resolve an error. Session-open failures leave existing data in place for inspection.

## Public repository and private runtime data

This repository is public; its package remains marked private to prevent accidental npm publication. Keep `.env`, credentials, database files, conversations, logs and browser traces out of commits. The ignore rules cover default local artifacts, but are not a substitute for reviewing a change. Keep any custom data directory outside tracked source.

Provider credentials are server-only. Requests go to OpenCode Go and the selected model provider; conversation storage contains sensitive input/output. Protect that directory and any backups accordingly. The server applies an owner-only creation mask. API responses expose a small presentation schema, not raw SDK documents or provider diagnostics. Consult [OpenCode Go's privacy settings](https://opencode.ai/docs/go/#privacy); access to DeepSeek may require the workspace to allow Global regions. The application does not change those settings.

The server binds to loopback and rejects foreign hosts/origins; it is not an authenticated service. Do not expose it through a LAN bind, tunnel, reverse proxy or public host without a separate access-control decision.

Transcript projection preserves ordered text, tool calls/results and omission receipts for unsupported content. Tool arguments and output are private conversation content, not sanitized diagnostics; raw provider diagnostics and arbitrary SDK documents stay server-side. Unambiguous live-to-entry handovers retain mounted row identity while keeping canonical durable IDs separate; cancellation, error and output limits differ. See [projection semantics and limits](docs/chat-components.md#transcript-identity-and-projection-batch-2).

## Checks

```sh
pnpm check
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:browser
pnpm exec playwright test --config=playwright.presentation.config.ts
```

`pnpm check` runs Vite+ formatting, type-aware lint and type checks, plus separate strictest client/server/tool TypeScript configurations. Client/shared imports are restricted from Node and SDK/server modules. `pnpm-workspace.yaml` holds pnpm tool policies only; this is a single package, not a workspace monorepo.

The Actions workflow runs separate `tsc`, `lint`, `fmt` and `test` jobs on PRs and pushes to `main`, using standard GitHub-hosted `ubuntu-latest` runners. These are the required checks for protected `main`; its protection also requires a PR and an up-to-date branch, applies to administrators, and blocks force-pushes/deletion. Build and browser checks above are additional local verification, not part of these four required jobs.

All external contributors require workflow approval in repository settings. Review workflow changes before approval; CI uses a read-only token and needs no provider credentials.

Integration tests use the real SDK and SQLite with a controllable test provider. Browser tests exercise the built frontend through Hono/SSE and the real SDK, substituting only the provider. They do not establish that a live OpenCode Go credential/request succeeds. These checks need no provider secrets. Browser traces may contain conversation text; local tests use synthetic data only.

The separate presentation browser configuration uses Vite on port 5173 (reusing the live client when available) and synthetic API state. `CPD_PRESENTATION_URL=http://127.0.0.1:5174` selects an isolated client port when needed. Tests intercept API traffic and never submit to the running conversation. Coverage includes loading/empty presentation, history prepend/gap recovery, stale-read protection, independent read/delivery retries, run controls, drafts, native reasoning/tools and the default theme. It does not replace the full SDK/browser suite.

## Read next

- [Problem and learning](docs/problem-and-learning.md): the needs and experiences behind the reset.
- [Design direction](docs/design.md): settled baseline, proposals and unresolved questions.
- [pi-durable feature inventory](docs/pi-durable-features.md): SDK capabilities, current chat coverage and possible enrichment choices.
- [Chat component mapping](docs/chat-components.md): accepted presentation, reusable boundaries and incremental delivery status.
- [assistant-ui element review](docs/assistant-ui-elements.md): full catalogue applicability, native adoption choices and host-data boundaries.
- [Documentation conventions](docs/CONTRIBUTING.md): where material belongs and how to maintain it.
- [Agent entrypoint](AGENTS.md): scoped instructions for agents changing this repository.
