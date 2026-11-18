import { defineConfig } from "@playwright/test";
import { env } from "node:process";

const baseURL = env["CPD_PRESENTATION_URL"] ?? "http://127.0.0.1:5173";
const port = Number(new URL(baseURL).port);
// Presentation tests intercept API traffic and use an isolated client.
export default defineConfig({
  testDir: "./tests",
  testMatch: [
    "chat-presentation.spec.ts",
    "chat-sidebar.spec.ts",
    "theme.spec.ts",
    "codemode.spec.ts",
    "direct-shell.spec.ts",
    "history-operations.spec.ts",
    "edit-branch.spec.ts",
    "edit-diff.spec.ts",
    "questions.spec.ts",
    "saved-prompts.spec.ts",
    "structured-table.spec.ts",
    "templates.spec.ts",
    "model-policy.spec.ts",
    "regeneration.spec.ts",
    "attachment-browser.spec.ts",
  ],
  workers: 1,
  use: { baseURL },
  webServer: {
    command: `pnpm exec vp dev --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
  },
});
