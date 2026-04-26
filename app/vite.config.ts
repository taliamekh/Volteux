import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// 5173 is taken by an unrelated React Router app on this machine.
// Pick 5174 so the Volteux UI dev server has a stable, predictable port.
export default defineConfig({
  plugins: [react()],
  resolve: {
    // Sibling-folder TS files (../schemas/document.zod.ts, ../components/registry.ts)
    // import bare modules like "zod". Those files live outside this Vite root,
    // so Vite's default resolver doesn't find app/node_modules. Aliasing the
    // bare specifier here points all consumers — including sibling files — at
    // app/node_modules/zod. (See U1 of the v0.1 UI completion plan.)
    alias: {
      zod: fileURLToPath(new URL("./node_modules/zod/index.js", import.meta.url)),
    },
  },
  server: {
    port: 5174,
    strictPort: false,
    host: "127.0.0.1",
    fs: {
      // Allow Vite to serve files from sibling folders (../schemas, ../components,
      // ../fixtures). Default `fs.allow` is the workspace root inferred from
      // the lockfile, which here is `app/`.
      allow: [".."],
    },
    // Proxy /api/* to the local pipeline-api server (default port 8788).
    // pipeline-api wraps runPipeline; runPipeline itself talks to the
    // Compile API on 8787 server-side. The browser never calls 8787
    // directly. Override either port via VITE_PIPELINE_API_URL.
    proxy: {
      "/api": {
        target: process.env.VITE_PIPELINE_API_URL ?? "http://127.0.0.1:8788",
        changeOrigin: true,
        // 60s timeout — Sonnet generate + arduino-cli compile lands at ~15-30s
        // typical, with the cross-gate repair retry pushing the worst case
        // toward 50s. 60s gives headroom without letting a stuck request
        // block the browser indefinitely.
        timeout: 60_000,
      },
    },
  },
});
