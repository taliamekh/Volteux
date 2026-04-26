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
  },
});
