import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: [
    "tangent-production.spec.ts",
    "tangent-split.spec.ts",
    "tangent-workspace.spec.ts",
    "draft-autosave.spec.ts",
    "draft-restoration.spec.ts",
    "draft-workspace.spec.ts",
  ],
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
