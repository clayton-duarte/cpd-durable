import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { defineExtension, defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { getOrThrow, type ExecutionEnv } from "@earendil-works/pi-durable/env";
import { z } from "zod";

const pathFields = {
  path: z.string().min(1).default("."),
  hidden: z.boolean().default(false),
};
const searchFields = {
  ...pathFields,
  ignore: z.boolean().default(true),
};
const GrepInput = z.strictObject({
  ...searchFields,
  pattern: z.string(),
  literal: z.boolean().default(false),
  ignoreCase: z.boolean().default(false),
  glob: z.string().optional(),
  limit: z.number().int().min(1).max(10_000).default(100),
});
const FindInput = z.strictObject({
  ...searchFields,
  pattern: z.string().min(1),
  limit: z.number().int().min(1).max(10_000).default(1000),
});
const LsInput = z.strictObject({
  ...pathFields,
  hidden: z.boolean().default(true),
  limit: z.number().int().min(1).max(10_000).default(1000),
});
const RgText = z.union([
  z.object({ text: z.string() }),
  z
    .object({ bytes: z.string() })
    .transform(({ bytes }) => Buffer.from(bytes, "base64").toString("utf8")),
]);
const MatchEvent = z.object({
  type: z.literal("match"),
  data: z.object({
    path: RgText,
    lines: RgText,
    line_number: z.number().int().positive(),
  }),
});

// These are output/record bounds, not command deadlines or filesystem boundaries.
const MAX_RECORD_CHARS = 128 * 1024;
const MAX_LINE_CHARS = 4000;
const outputLimits = { maxBytes: 50 * 1024, maxLines: 2000, retain: "head" as const };

function environment(api: ToolExecutionApi): ExecutionEnv {
  if (!api.env) throw new Error("Search tools require a host execution environment.");
  return api.env;
}

function checkCancelled(context: Context) {
  context.abortSignal?.throwIfAborted();
}

function results(api: ToolExecutionApi, limit: number) {
  let count = 0;
  let truncated = false;
  return {
    add(line: string) {
      if (count >= limit) {
        truncated = true;
        return;
      }
      count++;
      if (line.length > MAX_LINE_CHARS) {
        line = `${line.slice(0, MAX_LINE_CHARS)} … [line truncated]`;
        truncated = true;
      }
      api.output(`${line}\n`);
    },
    omitted() {
      truncated = true;
    },
    finish() {
      if (count === 0 && !truncated) api.output("No results.\n");
      if (truncated)
        api.diagnostic({
          severity: "warn",
          code: "search_output_truncated",
          message:
            "Search output truncated: the result limit, line limit or record-size limit was exceeded. Narrow the query or increase limit; SDK output limits still apply.",
        });
    },
  };
}

/**
 * Split streamed records without retaining an unbounded line/path. An oversized
 * JSON match is explicitly omitted, never misreported as an exhaustive no-match.
 */
function records(separator: string, receive: (record: string) => void, omitted: () => void) {
  let pending = "";
  let dropping = false;
  return {
    push(chunk: string) {
      let start = 0;
      while (start < chunk.length) {
        const end = chunk.indexOf(separator, start);
        const part = chunk.slice(start, end < 0 ? undefined : end);
        if (!dropping) {
          if (pending.length + part.length > MAX_RECORD_CHARS) {
            pending = "";
            dropping = true;
            omitted();
          } else pending += part;
        }
        if (end < 0) break;
        if (!dropping && pending) receive(pending);
        pending = "";
        dropping = false;
        start = end + separator.length;
      }
    },
    finish() {
      if (!dropping && pending) receive(pending);
    },
  };
}

async function ripgrep(
  executable: string,
  args: string[],
  api: ToolExecutionApi,
  context: Context,
  stdout: (text: string) => void,
) {
  let stderr = "";
  // argv only; no shell parsing, listFiles convenience deadline, or forced timeout.
  const result = await environment(api).exec(
    [executable, "--no-config", ...args],
    {
      onOutput(text, _context, info) {
        if (info.stream === "stdout") stdout(text);
        else stderr = (stderr + text).slice(0, 8000);
      },
    },
    context,
  );
  checkCancelled(context);
  if (!result.ok) {
    if (result.error.code === "spawn_error")
      throw new Error(
        "Could not start ripgrep. Install rg on the host or configure its executable, and verify the working directory exists.",
      );
    throw new Error(`Search process failed (${result.error.code}).`);
  }
  // rg: 0 = matches/files, 1 = none, 2 = error (possibly partial results).
  if (result.value.exitCode !== 0 && result.value.exitCode !== 1)
    throw new Error(`ripgrep exited with code ${result.value.exitCode}: ${stderr.trim()}`);
}

function traversalFlags(input: { hidden: boolean; ignore: boolean }) {
  return [...(input.hidden ? ["--hidden"] : []), ...(!input.ignore ? ["--no-ignore"] : [])];
}

/**
 * Optional read-only tools; installing this extension does not change authority.
 *
 * grep/find require ripgrep on the execution host (default executable "rg").
 * ls needs only ExecutionEnv.openDirReader. All paths are resolved by that env:
 * "." follows the conversation cwd, including the app's existing home default.
 * Absolute/parent paths and explicitly selected symlink roots are permitted.
 *
 * rg does not follow discovered symlinks; explicitly supplied symlink paths may
 * be followed. Hidden paths and ignore handling are separate switches. rg's
 * normal ignore rules apply by default; .git metadata requires explicit paths
 * or globs under rg's rules. No project resource discovery/loading is performed.
 * These read-only operations are replay-safe, but a retry after interruption
 * can observe files that changed since the earlier attempt.
 *
 * Results stream in traversal order (not globally sorted). grep counts matching
 * lines, find counts file paths, ls counts immediate entries. The result limit
 * bounds display, not runtime: rg continues scanning so errors remain visible.
 * Oversized records/lines are labeled as truncated; invalid UTF-8 is replaced
 * when rendering. No complete-output spill file is promised by these adapters.
 */
export function createSearchTools(options: { ripgrep?: string } = {}) {
  const executable = options.ripgrep ?? "rg";
  return defineExtension({
    name: "cpd-search-tools",
    tools: [
      defineTool({
        name: "grep",
        description:
          "Search text files using ripgrep. pattern is a Rust regex (no lookaround/backreferences), or exact text with literal=true; ignoreCase is optional. Returns filename, 1-based line number and matching line, not match occurrences. Binary files are normally skipped; no multiline matching. path defaults to cwd; absolute/parent paths work. Optional glob uses ripgrep gitignore-style syntax. hidden=false and ignore=true by default (ignore files/global rules apply); explicit paths/globs can override exclusions per rg. Discovered symlinks are not followed. Requires host rg. limit defaults to 100 matching lines; output/record bounds are labeled, not a timeout. No shell interpolation. A replay after interruption may read changed files.",
        parameters: z.toJSONSchema(GrepInput, { io: "input" }),
        replay: "safe",
        outputLimits,
        async execute(args, api, context) {
          const input = GrepInput.parse(args);
          const env = environment(api);
          checkCancelled(context);
          const path = getOrThrow(await env.absolutePath(input.path, context));
          const output = results(api, input.limit);
          const stream = records(
            "\n",
            (record) => {
              const event: unknown = JSON.parse(record);
              if (z.object({ type: z.string() }).parse(event).type !== "match") return;
              const { data } = MatchEvent.parse(event);
              const filename = typeof data.path === "string" ? data.path : data.path.text;
              const line = typeof data.lines === "string" ? data.lines : data.lines.text;
              output.add(
                `${JSON.stringify(filename)}:${data.line_number}: ${line.replace(/\r?\n$/, "")}`,
              );
            },
            () => output.omitted(),
          );
          await ripgrep(
            executable,
            [
              "--json",
              "--color=never",
              ...traversalFlags(input),
              ...(input.literal ? ["--fixed-strings"] : []),
              ...(input.ignoreCase ? ["--ignore-case"] : []),
              ...(input.glob === undefined ? [] : ["--glob", input.glob]),
              "--regexp",
              input.pattern,
              "--",
              path,
            ],
            api,
            context,
            (text) => stream.push(text),
          );
          stream.finish();
          output.finish();
          return {};
        },
      }),
      defineTool({
        name: "find",
        description:
          "Find file paths using ripgrep --files and a required gitignore-style glob pattern (e.g. **/*.ts), not shell find predicates or a regex. Lists files, not directories; discovered symlinks are not followed. path defaults to cwd; absolute/parent paths work. A matching positive glob overrides hidden and ignore exclusions, so *.txt can include hidden or ignored files even with hidden=false and ignore=true; explicitly selected paths also override exclusions. Requires host rg. Output is JSON-quoted paths in traversal order, limit=1000 by default. Limits bound output, not runtime. No shell interpolation. A replay after interruption may read changed files.",
        parameters: z.toJSONSchema(FindInput, { io: "input" }),
        replay: "safe",
        outputLimits,
        async execute(args, api, context) {
          const input = FindInput.parse(args);
          const env = environment(api);
          checkCancelled(context);
          const path = getOrThrow(await env.absolutePath(input.path, context));
          const output = results(api, input.limit);
          const stream = records(
            "\0",
            (record) => output.add(JSON.stringify(record)),
            () => output.omitted(),
          );
          await ripgrep(
            executable,
            ["--files", "--null", ...traversalFlags(input), "--glob", input.pattern, "--", path],
            api,
            context,
            (text) => stream.push(text),
          );
          stream.finish();
          output.finish();
          return {};
        },
      }),
      defineTool({
        name: "ls",
        description:
          "List immediate directory entries through the host filesystem; no external executable. JSON-quoted names prefixed with file/directory/symlink; symlinks are listed, not traversed. An explicitly selected symlink directory may be opened. path defaults to cwd; absolute/parent paths work. Includes dotfiles by default (hidden=true), ignores no gitignore rules. Filesystem traversal order, not sorted. limit=1000 by default; labeled output bounds, no timeout. A replay after interruption may read changed files.",
        parameters: z.toJSONSchema(LsInput, { io: "input" }),
        replay: "safe",
        outputLimits,
        async execute(args, api, context) {
          const input = LsInput.parse(args);
          const env = environment(api);
          checkCancelled(context);
          const reader = getOrThrow(await env.openDirReader(input.path, context));
          const output = results(api, input.limit);
          let count = 0;
          try {
            while (true) {
              checkCancelled(context);
              const page = getOrThrow(await reader.next(128, context));
              for (const entry of page.entries) {
                if (!input.hidden && entry.name.startsWith(".")) continue;
                if (count === input.limit) {
                  output.omitted();
                  output.finish();
                  return {};
                }
                output.add(`${entry.kind} ${JSON.stringify(entry.name)}`);
                count++;
              }
              if (page.done) break;
            }
          } finally {
            await reader.close(BACKGROUND_CONTEXT);
          }
          output.finish();
          return {};
        },
      }),
    ],
  });
}
