import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it, vi } from "vite-plus/test";
import { createApp } from "../src/server/app.ts";
import { openChat } from "../src/server/chat.ts";
import { DraftAttemptRecoveryPageSchema } from "../src/shared/drafts.ts";
import { testModels } from "./models.ts";

describe("draft attempt recovery list", () => {
  it("reopens without IDs, paginates truthfully, and reports actual SDK admission", async () => {
    const dir = await mkdtemp(join(tmpdir(), "attempt-list-"));
    const provider = testModels();
    let host = await openChat(dir, provider.models, dir);
    try {
      let app = createApp(host);
      const base = `http://localhost:3000/api/chats/${host.conversation.id}`;
      const json = (path: string, method: string, body: unknown) =>
        app.request(base + path, {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      expect(
        (
          await json("/draft", "PUT", {
            expectedRevision: 0,
            content: { text: "  test  ", images: [] },
          })
        ).status,
      ).toBe(200);
      const attempts = Array.from({ length: 23 }, () => ({
        requestId: crypto.randomUUID(),
        draftRevision: 1,
        text: "  test  ",
        images: [],
        mode: "reject",
      }));
      for (const attempt of attempts)
        expect((await json("/draft/attempt", "POST", attempt)).status).toBe(200);
      expect(provider.calls).toHaveLength(0);
      const first = attempts[0]!;
      const admitted = await json("/input", "POST", {
        requestId: first.requestId,
        text: "test",
        draft: { revision: 1, text: first.text, images: [], attempt: true },
      });
      expect(admitted.status).toBe(202);
      const { id } = (await admitted.json()) as { id: string };
      await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
      provider.calls[0]!.finish("done");
      await host.conversation.waitForIdle(BACKGROUND_CONTEXT);
      await host.close();
      host = await openChat(dir, provider.models, dir);
      app = createApp(host);

      const response = await app.request(`${base}/draft/attempts`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const page = DraftAttemptRecoveryPageSchema.parse(await response.json());
      expect(page.attempts).toHaveLength(20);
      expect(page.capped).toBe(true);
      expect(page.nextCursor).toBe(attempts[3]!.requestId);
      expect(page.attempts.map((entry) => entry.record.requestId)).toEqual(
        attempts
          .slice(3)
          .reverse()
          .map((attempt) => attempt.requestId),
      );
      expect(page.attempts.every((entry) => entry.admission === "unknown")).toBe(true);
      // A new attempt inserted between page reads must not shift the anchored older page.
      expect(
        (
          await json("/draft", "PUT", {
            expectedRevision: 2,
            content: { text: "new draft", images: [] },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await json("/draft/attempt", "POST", {
            requestId: crypto.randomUUID(),
            draftRevision: 3,
            text: "new draft",
            images: [],
            mode: "reject",
          })
        ).status,
      ).toBe(200);
      const older = DraftAttemptRecoveryPageSchema.parse(
        await (await app.request(`${base}/draft/attempts?cursor=${page.nextCursor}`)).json(),
      );
      expect(older.capped).toBe(false);
      expect(older.nextCursor).toBeNull();
      expect(older.attempts.map((entry) => entry.record.requestId)).toEqual(
        attempts
          .slice(0, 3)
          .reverse()
          .map((attempt) => attempt.requestId),
      );
      expect(older.attempts[2]).toMatchObject({
        record: first,
        admission: "admitted",
        submissionId: id,
      });
      expect(provider.calls).toHaveLength(1);
      expect((await app.request(`${base}/draft/attempts?cursor=bad`)).status).toBe(400);
      expect(
        (await app.request(`${base}/draft/attempts?cursor=${crypto.randomUUID()}`)).status,
      ).toBe(400);
      expect((await app.request(`${base}/draft/attempts?other=x`)).status).toBe(400);
      expect(
        (
          await app.request(
            `${base}/draft/attempts?cursor=${page.nextCursor}&cursor=${page.nextCursor}`,
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await app.request(`${base}/draft/attempts`, {
            headers: { origin: "https://example.invalid" },
          })
        ).status,
      ).toBe(403);

      const other = await host.chats.create(crypto.randomUUID());
      const otherBase = `http://localhost:3000/api/chats/${other.id}`;
      expect(await (await app.request(`${otherBase}/draft/attempts`)).json()).toEqual({
        attempts: [],
        capped: false,
        nextCursor: null,
      });
      expect(
        (await app.request(`${otherBase}/draft/attempts?cursor=${page.nextCursor}`)).status,
      ).toBe(400);
      const entries = await host.conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
      const entry = entries.items.find((item) => item.kind === "pi.user")!;
      const fork = await host.chats.fork(
        String(host.conversation.id),
        crypto.randomUUID(),
        String(entry.id),
      );
      expect(
        await (
          await app.request(`http://localhost:3000/api/chats/${fork.id}/draft/attempts`)
        ).json(),
      ).toEqual({ attempts: [], capped: false, nextCursor: null });
      const root = String(host.conversation.id);
      await host.chats.change(root, "archive");
      expect((await app.request(`${base}/draft/attempts`)).status).toBe(200);
      await host.chats.change(root, "delete");
      expect((await app.request(`${base}/draft/attempts`)).status).toBe(404);
      expect(provider.calls).toHaveLength(1);
    } finally {
      await host.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
