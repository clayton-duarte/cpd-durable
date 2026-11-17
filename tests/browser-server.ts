import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "../src/server/app.ts";
import { openChat } from "../src/server/chat.ts";
import { testModels } from "./models.ts";

// Test-only model substitution. Production has no fake-provider flag or route.
const provider = testModels((call) => {
  const last = call.context.messages.at(-1);
  const text =
    last?.role === "user"
      ? typeof last.content === "string"
        ? last.content
        : last.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("")
      : "";
  if (text === "Fail next") {
    setTimeout(() => call.fail(), 100);
  } else if (text === "Slow response") {
    setTimeout(() => call.partial("A streamed partial"), 150);
  } else {
    setTimeout(() => call.partial("Hello"), 150);
    setTimeout(() => call.finish("Hello from the test provider"), 500);
  }
});
const directory = await mkdtemp(join(tmpdir(), "cpd-browser-test-"));
const chat = await openChat(directory, provider.models);
const app = createApp(chat.conversation);
app.get("*", serveStatic({ root: "./dist/client" }));
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 3000 });
const shutdown = () => {
  server.close();
  void chat.close().then(async () => {
    if ("closeAllConnections" in server) server.closeAllConnections();
    await rm(directory, { recursive: true, force: true });
  });
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
