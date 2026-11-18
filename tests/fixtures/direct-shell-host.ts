import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openChat } from "../../src/server/chat.ts";
import { createApp } from "../../src/server/app.ts";
import { testModels } from "../models.ts";

const [mode, directory] = process.argv.slice(2);
if (!directory) throw new Error("Missing test directory.");
const provider = testModels();
const chat = await openChat(directory, provider.models, directory);
const app = createApp(chat);
const path = `/api/chats/${chat.conversation.id}`;
const request = (suffix: string, body?: unknown) =>
  app.request(
    `http://localhost:3000${path}${suffix}`,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );

if (mode === "hold") {
  chat.conversation.compact = async () => {
    process.send?.({ event: "held" });
    return await new Promise<never>(() => {});
  };
  void request("/compact", { instructions: "synthetic" });
} else if (mode === "recover") {
  const before = (await (await request("/compact/reservation")).json()) as {
    id: string;
    pending: boolean;
    recoveryRequiresRestart: boolean;
  };
  const release = (await (await request("/compact/recover", { id: before.id })).json()) as {
    status: string;
    outcome: string;
  };
  const requestId = crypto.randomUUID();
  const response = await request("/shell", {
    requestId,
    command: "printf process-fixture",
    includeInContext: false,
  });
  const receipt = (await response.json()) as { id: string };
  await chat.conversation.waitForIdle(BACKGROUND_CONTEXT);
  const status = (await (await request(`/shell?requestId=${requestId}`)).json()) as {
    status: string;
    output: string;
    includeInContext: boolean;
  };
  process.send?.({
    event: "recovered",
    before,
    release,
    receipt,
    status,
    providerCalls: provider.calls.length,
  });
  await chat.close();
  process.disconnect?.();
}
