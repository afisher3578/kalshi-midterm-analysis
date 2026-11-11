import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

// Processed race JSON lives outside web/ (data/processed, written by the Python pipeline).
// Dev server serves it under /data/, the build copies it to dist/data/. Nothing is fetched remotely.
const PROCESSED = resolve(import.meta.dirname, "../data/processed");
const NAME = /^[a-z0-9-]+\.json$/;

function processedData(): Plugin {
  return {
    name: "processed-data",
    configureServer(server) {
      server.middlewares.use("/data", (req, res, next) => {
        const name = (req.url ?? "").split("?")[0].replace(/^\//, "");
        if (!NAME.test(name)) return next();
        try {
          const body = readFileSync(join(PROCESSED, name));
          res.setHeader("Content-Type", "application/json");
          res.end(body);
        } catch {
          next();
        }
      });
    },
    generateBundle() {
      for (const name of readdirSync(PROCESSED).filter((n) => NAME.test(n))) {
        this.emitFile({ type: "asset", fileName: `data/${name}`, source: readFileSync(join(PROCESSED, name)) });
      }
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [processedData()],
  build: { outDir: "dist", emptyOutDir: true },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
  server: { host: "127.0.0.1" },
});
