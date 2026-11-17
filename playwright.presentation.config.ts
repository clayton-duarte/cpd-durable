import { defineConfig } from "@playwright/test";

// Presentation tests intercept all API traffic; safe against the live development client.
export default defineConfig({
  testDir: "./tests",
  testMatch: ["chat-presentation.spec.ts", "theme.spec.ts"],
  workers: 1,
  use: { baseURL: "http://127.0.0.1:5173" },
  webServer: {
    command: "pnpm exec vp dev",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: true,
  },
});
