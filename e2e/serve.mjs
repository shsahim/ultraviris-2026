// Starts the production server for Playwright E2E using Next's standalone
// output (output: "standalone" in next.config.ts). `next start` does not work
// with standalone builds, so we assemble the runtime the same way the
// Dockerfile does — copy the static assets and public/ next to server.js — and
// then launch it. Honors E2E_PORT (default 3000) to match playwright.config.ts.
import { cpSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const standalone = path.join(root, ".next", "standalone");

if (!existsSync(path.join(standalone, "server.js"))) {
  console.error(
    "Standalone server not found. Run `npm run build` before the E2E suite."
  );
  process.exit(1);
}

// Mirror Dockerfile COPY steps: static assets and public/ are not included in
// .next/standalone by next build and must be placed alongside server.js.
cpSync(path.join(root, ".next", "static"), path.join(standalone, ".next", "static"), {
  recursive: true,
});
if (existsSync(path.join(root, "public"))) {
  cpSync(path.join(root, "public"), path.join(standalone, "public"), {
    recursive: true,
  });
}

const port = process.env.E2E_PORT ?? "3000";
const child = spawn("node", [path.join(standalone, "server.js")], {
  stdio: "inherit",
  env: { ...process.env, PORT: port, HOSTNAME: "127.0.0.1" },
});
child.on("exit", (code) => process.exit(code ?? 0));
