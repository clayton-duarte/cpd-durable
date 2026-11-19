import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";

// Isolated visual fixture: never proxy to the user's running host.
export default defineConfig({
  plugins: [
    {
      name: "synthetic-preview-deep-links",
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (
            !process.env["CPD_UI_TEST"] &&
            req.method === "GET" &&
            /^\/chats(?:\/[^/?]+)?(?:\?.*)?$/.test(req.url ?? "")
          ) {
            req.url = "/tests/ui-preview/";
          }
          next();
        });
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "@": fileURLToPath(new URL("../src/client", import.meta.url)) } },
  server: { host: "127.0.0.1", port: 5208, strictPort: true },
});
