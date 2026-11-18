import { defineConfig } from "@playwright/test";
import { env } from "node:process";

const baseURL = env["CPD_PRESENTATION_URL"] ?? "http://127.0.0.1:5173";
const port = Number(new URL(baseURL).port);
// Presentation tests intercept all API traffic; safe against the live development client.
export default defineConfig({
  testDir: "./tests",
  testMatch: [
    "chat-presentation.spec.ts",
    "chat-sidebar.spec.ts",
    "theme.spec.ts",
    "codemode.spec.ts",
    "history-operations.spec.ts",
    "edit-branch.spec.ts",
    "questions.spec.ts",
    "model-policy.spec.ts",
  ],
  workers: 1,
  use: { baseURL },
  webServer: {
    command: `pnpm exec vp dev --port ${port}`,
    url: baseURL,
    reuseExistingServer: true,
  },
});
