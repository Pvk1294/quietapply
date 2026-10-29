import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Paths } from "../core/paths.js";

/**
 * Where the SMTP app password lives: the OS keychain where there is one (macOS Keychain, the Secret
 * Service on Linux through `secret-tool`), otherwise a file readable only by you in the data folder.
 * The password is passed on stdin, never on a command line, and never logged or returned by the API.
 */
export const SERVICE = "quietapply-smtp";

export interface SecretDeps {
  platform?: NodeJS.Platform;
  /** Runs a command with input on stdin and returns stdout. Throws when the command fails. */
  run?: (cmd: string, args: string[], input?: string) => string;
}

const realRun = (cmd: string, args: string[], input?: string) =>
  execFileSync(cmd, args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], timeout: 15_000 });

const fileOf = (p: Paths) => join(p.home, "smtp-password.json");

/** `security -i` reads one command per line; quote its arguments the way it expects. */
const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export type SecretStore = "keychain" | "secret-service" | "file";

export function savePassword(p: Paths, user: string, password: string, deps: SecretDeps = {}): SecretStore {
  if (!user || !password) throw new Error("A login and an app password are both needed");
  if (/[\r\n]/.test(password) || /[\r\n]/.test(user))
    throw new Error("The password cannot contain line breaks");
  const platform = deps.platform ?? process.platform;
  const run = deps.run ?? realRun;
  try {
    if (platform === "darwin") {
      run("security", ["-i"], `add-generic-password -U -s ${q(SERVICE)} -a ${q(user)} -w ${q(password)}\n`);
      forgetFile(p);
      return "keychain";
    }
    if (platform === "linux") {
      run("secret-tool", ["store", "--label=QuietApply SMTP", "service", SERVICE, "account", user], password);
      forgetFile(p);
      return "secret-service";
    }
  } catch {
    // No keychain available (for example a Linux server without a Secret Service): use the private file.
  }
  writeFileSync(fileOf(p), JSON.stringify({ user, password }), { mode: 0o600 });
  return "file";
}

export function readPassword(p: Paths, user: string, deps: SecretDeps = {}): string | undefined {
  const platform = deps.platform ?? process.platform;
  const run = deps.run ?? realRun;
  try {
    if (platform === "darwin") {
      const out = run("security", ["find-generic-password", "-s", SERVICE, "-a", user, "-w"]).replace(
        /\n$/,
        "",
      );
      if (out) return out;
    }
    if (platform === "linux") {
      const out = run("secret-tool", ["lookup", "service", SERVICE, "account", user]).replace(/\n$/, "");
      if (out) return out;
    }
  } catch {
    // not in the keychain: try the file
  }
  if (!existsSync(fileOf(p))) return undefined;
  try {
    const f = JSON.parse(readFileSync(fileOf(p), "utf8")) as { user?: string; password?: string };
    return f.user === user ? f.password : undefined;
  } catch {
    return undefined;
  }
}

/** Remove the stored password everywhere it may be (turning email off calls this). */
export function forgetPassword(p: Paths, user: string | undefined, deps: SecretDeps = {}): void {
  const platform = deps.platform ?? process.platform;
  const run = deps.run ?? realRun;
  if (user)
    try {
      if (platform === "darwin") run("security", ["delete-generic-password", "-s", SERVICE, "-a", user]);
      if (platform === "linux") run("secret-tool", ["clear", "service", SERVICE, "account", user]);
    } catch {
      // nothing stored there
    }
  forgetFile(p);
}

function forgetFile(p: Paths): void {
  if (existsSync(fileOf(p))) unlinkSync(fileOf(p));
}
