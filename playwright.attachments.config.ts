import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: [
    "attachment-browser.spec.ts",
    "chat-presentation.spec.ts",
    "chat-sidebar.spec.ts",
    "theme.spec.ts",
    "questions.spec.ts",
  ],
  workers: 1,
  use: { baseURL: "http://127.0.0.1:5181" },
  webServer: {
    command: "./node_modules/.bin/vp dev --host 127.0.0.1 --port 5181 --strictPort",
    url: "http://127.0.0.1:5181",
    reuseExistingServer: false,
  },
});
