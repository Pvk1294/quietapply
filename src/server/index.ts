import { serve } from "@hono/node-server";
import { loadConfig } from "../core/config.js";
import { ensureHome, paths } from "../core/paths.js";
import { createApp } from "./app.js";

/** Serve the dashboard on 127.0.0.1 only. */
export async function startDashboard(o: { port?: number } = {}): Promise<void> {
  const p = ensureHome(paths());
  const port = o.port ?? loadConfig(p).dashboard.port;
  const app = createApp({ p, port });
  await new Promise<void>((resolve, reject) => {
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, () => {
      console.log(`QuietApply dashboard: http://127.0.0.1:${port}  (data: ${p.home})`);
      resolve();
    });
    server.once("error", (err: NodeJS.ErrnoException) => reject(new Error(portProblem(err, port))));
  });
}

/** A plain sentence for the usual reason the dashboard cannot start, instead of a stack trace. */
export function portProblem(err: NodeJS.ErrnoException, port: number): string {
  if (err.code === "EADDRINUSE")
    return `port ${port} is already in use, maybe by another QuietApply dashboard. Open http://127.0.0.1:${port} or pick another port with --port ${port + 1}`;
  return err.message;
}
