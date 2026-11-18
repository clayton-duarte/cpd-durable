import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  testIgnore: ["browser.spec.ts", "ui-preview-refresh.spec.ts"],
  workers: 1,
  use: { baseURL: "http://127.0.0.1:5210", trace: "retain-on-failure" },
  webServer: {
    command:
      "CPD_UI_TEST=1 pnpm exec vp dev --config tests/ui-preview.config.ts --port 5210 --strictPort",
    cwd: "..",
    url: "http://127.0.0.1:5210",
    reuseExistingServer: false,
  },
});
