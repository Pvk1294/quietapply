// Smoke test for CI on macOS, Linux and Windows: start `quietapply demo`, wait until the dashboard
// answers, check the summary, then stop it. Exits non-zero on failure. Run after `npm run build`.
// Usage: node scripts/smoke-demo.mjs [port] [path to dist/cli/index.js, default this checkout's]
import { spawn } from "node:child_process";
import { join } from "node:path";

const port = Number(process.argv[2] ?? process.env.QA_PORT ?? 4790);
const cli = process.argv[3] ?? join(import.meta.dirname, "..", "dist", "cli", "index.js");
const demo = spawn(process.execPath, [cli, "demo", "--port", String(port)], {
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let output = "";
demo.stdout.on("data", (d) => {
  output += d;
});
demo.stderr.on("data", (d) => {
  output += d;
});

function finish(code, message) {
  console.log(message);
  if (code) console.log(`demo output:\n${output}`);
  demo.kill();
  process.exit(code);
}

demo.on("exit", (code) => finish(1, `demo exited early with code ${code}`));
const deadline = Date.now() + 60_000;
for (;;) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/summary`);
    if (r.ok) {
      const body = await r.json();
      if (!JSON.stringify(body).includes("Jane")) finish(1, "dashboard answered without the demo persona");
      demo.removeAllListeners("exit");
      finish(0, `demo dashboard answered on port ${port} with the Jane Doe demo data`);
    }
  } catch {
    // not listening yet
  }
  if (Date.now() > deadline) finish(1, "demo dashboard did not answer within 60 seconds");
  await new Promise((r) => setTimeout(r, 500));
}
