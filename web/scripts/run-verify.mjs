// `npm run verify`: one command for every render check. Starts the Python dashboard server twice on free ports
// (real data, and --demo), runs scripts/verify-dashboard.mjs (map plus line chart, demo label) against them, then
// stops both servers. scripts/verify.mjs (race page) and scripts/verify-news.mjs (news view, empty state and demo)
// run only when web/src/config.ts has SHOW_DETAILS = true, since those views are hidden otherwise.
// Serves the existing web/dist (run `npm run build` first).
// The servers bind 127.0.0.1 only. Usage: npm run verify
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const PY = existsSync(resolve(ROOT, ".venv/bin/python")) ? resolve(ROOT, ".venv/bin/python") : "python3";

if (!existsSync(resolve(ROOT, "web/dist/index.html"))) {
  console.error("web/dist is missing: run `npm run build` first");
  process.exit(2);
}

function startServer(demo) {
  const args = ["-m", "raceattn", "dashboard", "--race", "tx-senate-2026", "--port", "0", "--no-open", "--no-build",
    ...(demo ? ["--demo"] : [])];
  const p = spawn(PY, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((ok, fail) => {
    let out = "";
    const t = setTimeout(() => fail(new Error(`server did not start: ${out}`)), 30_000);
    p.stdout.on("data", (b) => {
      out += b;
      const m = out.match(/Dashboard: (http:\/\/127\.0\.0\.1:\d+)\//);
      if (m) { clearTimeout(t); ok({ proc: p, base: `${m[1]}/` }); }
    });
    p.stderr.on("data", () => {});  // request log
    p.on("exit", (code) => { clearTimeout(t); fail(new Error(`server exited (${code}): ${out}`)); });
  });
}

function run(script, args) {
  return new Promise((ok) => {
    const p = spawn(process.execPath, [resolve(import.meta.dirname, script), ...args], { stdio: "inherit" });
    p.on("exit", (code) => ok(code ?? 1));
  });
}

const live = await startServer(false);
const demo = await startServer(true);
let code = 1;
try {
  console.log(`live server ${live.base}, demo server ${demo.base}`);
  const details = /export const SHOW_DETAILS = true/.test(readFileSync(resolve(ROOT, "web/src/config.ts"), "utf-8"));
  const c = await run("verify-dashboard.mjs", [live.base, demo.base]);
  const a = details ? await run("verify.mjs", [live.base]) : 0;
  const b = details ? await run("verify-news.mjs", [live.base, demo.base]) : 0;
  code = a || b || c;
  console.log(`verify-dashboard.mjs exit ${c}; ${details ? `verify.mjs exit ${a}, verify-news.mjs exit ${b}`
    : "verify.mjs and verify-news.mjs skipped (SHOW_DETAILS is false: the race detail views are hidden)"}`);
} finally {
  for (const s of [live, demo]) { s.proc.removeAllListeners("exit"); s.proc.kill("SIGTERM"); }
}
process.exit(code);
