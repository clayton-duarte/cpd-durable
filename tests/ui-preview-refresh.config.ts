import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "ui-preview-refresh.spec.ts",
  workers: 1,
  use: { baseURL: "http://127.0.0.1:5208" },
});
