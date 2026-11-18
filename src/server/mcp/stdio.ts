import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { z } from "zod";

export type StdioServer = {
  readonly id: string;
  readonly transport: "stdio";
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
};

const MAX_FRAME = 10 * 1024 * 1024;
const MAX_INFLIGHT = 1024;
const JsonRpc = z.looseObject({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number().int().safe(), z.null()]).optional(),
  method: z.string().optional(),
  result: z.unknown().optional(),
  error: z.looseObject({ code: z.number().int(), message: z.string() }).optional(),
});
type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  detach(): void;
};

/** MCP 2025-03-26 stdio transport; no request timers or automatic retries. */
export class StdioMcpClient {
  private readonly config: StdioServer;
  private child: ChildProcessWithoutNullStreams | undefined;
  private exit: Promise<void> | undefined;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private stopped = false;
  private stale = false;

  constructor(config: StdioServer) {
    this.config = config;
  }

  async connect() {
    if (this.stopped || this.child) throw new Error("MCP connection unavailable.");
    const child = spawn(this.config.command, [...this.config.args], {
      cwd: this.config.cwd,
      env: { ...process.env, ...this.config.env },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.exit = new Promise((resolve) => child.once("close", () => resolve()));
    child.stderr.resume(); // Drain, never log or forward server stderr.
    child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    child.on("error", () => this.fail());
    child.on("close", () => this.fail());
    child.stdin.on("error", () => this.fail());
    try {
      const value = await this.request("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "cpd-durable", version: "0.1.0" },
      });
      const init = z
        .looseObject({
          protocolVersion: z.literal("2025-03-26"),
          capabilities: z.looseObject({ tools: z.unknown().optional() }),
          serverInfo: z.looseObject({ name: z.string().min(1), version: z.string().min(1) }),
        })
        .safeParse(value);
      if (!init.success || init.data.capabilities.tools === undefined)
        throw new Error("MCP server does not support the required protocol and tools capability.");
      this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    } catch {
      await this.close();
      throw new Error("MCP initialization failed or the server is incompatible.");
    }
  }

  get catalogStale() {
    return this.stale;
  }

  async request(method: string, params: object, signal?: AbortSignal): Promise<unknown> {
    if (this.stopped || !this.child) throw new Error("MCP transport unavailable.");
    if (!["initialize", "tools/list", "tools/call"].includes(method))
      throw new Error("Unsupported MCP method.");
    if (this.pending.size >= MAX_INFLIGHT) throw new Error("MCP in-flight request limit exceeded.");
    signal?.throwIfAborted();
    const id = this.nextId++;
    return await new Promise((resolve, reject) => {
      const abort = () => {
        if (!this.pending.delete(id)) return;
        signal?.removeEventListener("abort", abort);
        try {
          this.send({
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId: id },
          });
        } catch {
          // A failed cancellation notification cannot undo remote effects.
        }
        reject(new Error("MCP request cancelled; remote effects may be uncertain."));
      };
      this.pending.set(id, {
        resolve,
        reject,
        detach: () => signal?.removeEventListener("abort", abort),
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch {
        const pending = this.pending.get(id);
        this.pending.delete(id);
        pending?.detach();
        reject(new Error("MCP transport unavailable; remote effects may be uncertain."));
      }
    });
  }

  private send(message: object) {
    const child = this.child;
    if (this.stopped || !child || child.stdin.destroyed)
      throw new Error("MCP transport unavailable.");
    const line = `${JSON.stringify(message)}\n`;
    if (
      Buffer.byteLength(line) > MAX_FRAME ||
      child.stdin.writableLength + Buffer.byteLength(line) > MAX_FRAME
    )
      throw new Error("MCP transport write limit exceeded.");
    child.stdin.write(line);
  }

  private receive(chunk: Buffer) {
    if (this.stopped) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const index = this.buffer.indexOf(10);
      if (index < 0) break;
      if (index > MAX_FRAME) return this.fail();
      const line = this.buffer.subarray(0, index);
      this.buffer = this.buffer.subarray(index + 1);
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(line);
        const message = JsonRpc.parse(JSON.parse(text) as unknown);
        if (message.method) {
          if (message.id !== undefined && message.id !== null) {
            this.send({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32601, message: "Method not supported." },
            });
          } else if (message.method === "notifications/tools/list_changed") this.stale = true;
          continue;
        }
        if (typeof message.id !== "number" || !Number.isSafeInteger(message.id) || message.id < 1)
          return this.fail();
        const pending = this.pending.get(message.id);
        if (!pending) continue; // Late response after cancellation.
        this.pending.delete(message.id);
        pending.detach();
        if (message.error !== undefined && message.result === undefined)
          pending.reject(new Error("MCP protocol request failed."));
        else if (message.error === undefined && message.result !== undefined)
          pending.resolve(message.result);
        else return this.fail();
      } catch {
        return this.fail();
      }
    }
    if (this.buffer.length > MAX_FRAME) this.fail();
  }

  private fail() {
    if (this.stopped) return;
    this.stopped = true;
    for (const pending of this.pending.values()) {
      pending.detach();
      pending.reject(new Error("MCP transport failed; remote effects may be uncertain."));
    }
    this.pending.clear();
    this.child?.stdin.destroy();
    this.child?.kill();
  }

  async close() {
    this.fail();
    await this.exit;
  }
}
