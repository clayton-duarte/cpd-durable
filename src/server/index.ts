import { once } from "node:events";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { createApp } from "./app.ts";
import { openChat } from "./chat.ts";
import { workingDirectory } from "./execution.ts";

const ConfigSchema = z.object({
  CPD_DATA_DIR: z.string().min(1).default("./data"),
  CPD_CWD: z.string().min(1).default("~"),
  CPD_EXTENSIONS_CONFIG: z.string().min(1).optional(),
  CPD_MCP_CONFIG: z.string().min(1).optional(),
});
const config = ConfigSchema.safeParse(process.env);
if (!config.success) {
  console.error("Invalid CPD server configuration.");
  process.exitCode = 1;
} else {
  process.umask(0o077);
  let models: ModelRuntime | undefined;
  let app: ReturnType<typeof createApp> | undefined;
  let chat: Awaited<ReturnType<typeof openChat>> | undefined;
  let stopping = false;
  // Acquire the fixed loopback listener before opening the writable session.
  // A second application process fails here; a crash releases it automatically.
  const server = serve({
    fetch: (request) =>
      app?.fetch(request) ?? Response.json({ error: "Starting." }, { status: 503 }),
    hostname: "127.0.0.1",
    port: 3000,
  });
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    server.close();
    void (chat?.close() ?? Promise.resolve())
      .then(() => models?.settleCredentialWrites())
      .then(
        () => {
          if ("closeAllConnections" in server) server.closeAllConnections();
        },
        () => {
          console.error("Session could not close cleanly.");
          if ("closeAllConnections" in server) server.closeAllConnections();
          process.exitCode = 1;
        },
      );
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    await once(server, "listening");
    if (!stopping) {
      models = await ModelRuntime.create();
    }
    if (!stopping && models) {
      chat = await openChat(
        resolve(config.data.CPD_DATA_DIR),
        models,
        workingDirectory(config.data.CPD_CWD),
        {
          ...(config.data.CPD_EXTENSIONS_CONFIG === undefined
            ? {}
            : { extensionsConfigPath: config.data.CPD_EXTENSIONS_CONFIG }),
          ...(config.data.CPD_MCP_CONFIG === undefined
            ? {}
            : { mcpConfigPath: config.data.CPD_MCP_CONFIG }),
        },
      );
      if (stopping) {
        await chat.close();
      } else {
        app = createApp(chat);
        app.get("*", serveStatic({ root: "./dist/client" }));
        app.get("/", serveStatic({ root: "./dist/client", path: "index.html" }));
        app.get("/chats/*", serveStatic({ root: "./dist/client", path: "index.html" }));
        app.get("/chats", serveStatic({ root: "./dist/client", path: "index.html" }));
        console.log("CPD Durable: http://127.0.0.1:3000");
      }
    }
  } catch {
    console.error(
      "Server could not start. Check the listener, local data directory and configured integrations.",
    );
    shutdown();
    process.exitCode = 1;
  }
}
