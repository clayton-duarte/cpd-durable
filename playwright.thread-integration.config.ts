import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: [
    "attachment-browser.spec.ts",
    "chat-presentation.spec.ts",
    "chat-sidebar.spec.ts",
    "theme.spec.ts",
    "codemode.spec.ts",
    "direct-shell.spec.ts",
    "edit-branch.spec.ts",
    "edit-diff.spec.ts",
    "structured-table.spec.ts",
    "templates.spec.ts",
    "history-operations.spec.ts",
    "questions.spec.ts",
    "model-policy.spec.ts",
    "tangent-production.spec.ts",
    "tangent-split.spec.ts",
    "tangent-workspace.spec.ts",
  ],
  workers: 1,
  use: { baseURL: "http://127.0.0.1:5182" },
  webServer: {
    command: "./node_modules/.bin/vp dev --config tests/tangent-fixture/vite.config.ts",
    url: "http://127.0.0.1:5182",
    reuseExistingServer: false,
  },
});
