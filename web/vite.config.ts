import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  build: { outDir: fileURLToPath(new URL("../dist/web", import.meta.url)), emptyOutDir: true },
  server: {
    // `npm run dev:web` talks to a dashboard started with `quietapply dashboard` (or `demo`).
    proxy: { "/api": { target: "http://127.0.0.1:4777", changeOrigin: true } },
  },
});
