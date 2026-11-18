import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "tangent-workspace.spec.ts",
  workers: 1,
  use: { baseURL: "http://127.0.0.1:5182" },
  webServer: {
    command: "./node_modules/.bin/vp dev --config tests/tangent-fixture/vite.config.ts",
    url: "http://127.0.0.1:5182/tests/tangent-fixture/",
    reuseExistingServer: false,
  },
});
