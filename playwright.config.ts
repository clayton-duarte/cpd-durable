import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  workers: 1,
  use: { baseURL: "http://127.0.0.1:3000", trace: "retain-on-failure" },
  webServer: {
    command: "pnpm exec tsx tests/browser-server.ts",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: false,
  },
});
