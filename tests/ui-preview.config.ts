import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";

// Isolated visual fixture: never proxy to the user's running host.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("../src/client", import.meta.url)) } },
  server: { host: "127.0.0.1", port: 5208, strictPort: true },
});
