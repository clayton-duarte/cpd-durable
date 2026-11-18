import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "draft-restoration.spec.ts",
  workers: 1,
  use: { baseURL: "http://127.0.0.1:5190" },
  webServer: {
    command: "pnpm exec vp dev --port 5190 --strictPort",
    cwd: "..",
    url: "http://127.0.0.1:5190",
    reuseExistingServer: false,
  },
});
