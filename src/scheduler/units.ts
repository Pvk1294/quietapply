import { homedir } from "node:os";
import { join } from "node:path";

export const LABEL = "dev.quietapply.tick";

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A per-user LaunchAgent that runs `quietapply tick` every 15 minutes and at login (macOS). */
export function launchdPlist(node: string, cli: string, home: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(node)}</string><string>${xml(cli)}</string><string>tick</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>QUIETAPPLY_HOME</key><string>${xml(home)}</string><key>PATH</key><string>${xml(process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin")}</string></dict>
  <key>StartInterval</key><integer>900</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${xml(join(home, "logs", "tick.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(home, "logs", "tick.log"))}</string>
</dict>
</plist>
`;
}

export function launchdPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

/** systemd --user service + timer (Linux). */
export function systemdUnits(node: string, cli: string, home: string): { service: string; timer: string } {
  return {
    service: `[Unit]
Description=QuietApply scheduled run check

[Service]
Type=oneshot
Environment=QUIETAPPLY_HOME=${home}
Environment=PATH=${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}
ExecStart=${node} ${cli} tick
`,
    timer: `[Unit]
Description=QuietApply: check for a due run every 15 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=15min
Persistent=true

[Install]
WantedBy=timers.target
`,
  };
}

export function systemdDir(): string {
  return join(homedir(), ".config", "systemd", "user");
}
