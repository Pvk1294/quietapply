#!/usr/bin/env node
// A stand-in for the `tailscale` CLI, so the phone command is tested without touching a real Serve config.
// State lives in the JSON file named by FAKE_TS_STATE; every call is appended to its "calls" list.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const file = process.env.FAKE_TS_STATE;
const st = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
st.mode ??= "ready";
st.host ??= "my-mac.tail1234.ts.net";
st.serve ??= { Web: {}, TCP: {}, AllowFunnel: {} };
st.calls ??= [];
const args = process.argv.slice(2);
st.calls.push(args);
const save = () => writeFileSync(file, JSON.stringify(st));
const out = (o) => console.log(JSON.stringify(o));

if (args[0] === "status") {
  if (st.mode === "logged_out") out({ BackendState: "NeedsLogin" });
  else
    out({
      BackendState: "Running",
      Self: { DNSName: `${st.host}.`, UserID: 42, TailscaleIPs: ["100.64.0.7"] },
      User: { 42: { LoginName: "jane.doe@example.com" } },
    });
} else if (args[0] === "serve" && args[1] === "status") {
  out(st.serve);
} else if (args[0] === "serve") {
  const port = (args.find((a) => a.startsWith("--https=")) ?? "--https=443").slice(8);
  const key = `${st.host}:${port}`;
  if (args.includes("off")) {
    delete st.serve.Web[key];
    delete st.serve.TCP[port];
    delete st.serve.AllowFunnel[key];
  } else {
    const target = args.find((a) => a.startsWith("http"));
    st.serve.TCP[port] = { HTTPS: true };
    st.serve.Web[key] = { Handlers: { "/": { Proxy: target } } };
    if (st.funnelOnServe) st.serve.AllowFunnel[key] = true;
  }
} else if (args[0] === "funnel") {
  st.serve.AllowFunnel[`${st.host}:443`] = true;
} else {
  console.error(`fake tailscale: unknown command ${args.join(" ")}`);
  save();
  process.exit(1);
}
save();
