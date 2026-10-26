import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = join(import.meta.dirname, "../install.sh");
const hasShellcheck = spawnSync("shellcheck", ["--version"]).status === 0;

/** A PATH with only stub commands (plus the basic tools bash needs), so the checks see a controlled machine. */
function stubPath(stubs: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "qa-install-bin-"));
  for (const [name, body] of Object.entries(stubs)) {
    const f = join(dir, name);
    writeFileSync(f, `#!/bin/sh\n${body}\n`);
    chmodSync(f, 0o755);
  }
  const sys = mkdtempSync(join(tmpdir(), "qa-install-sys-"));
  for (const tool of ["uname", "sed", "tr", "grep", "dirname", "basename", "head", "mkdir", "cat"]) {
    const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    if (found) {
      const f = join(sys, tool);
      writeFileSync(f, `#!/bin/sh\nexec ${found} "$@"\n`);
      chmodSync(f, 0o755);
    }
  }
  return `${dir}:${sys}`;
}

function install(args: string[], stubs: Record<string, string>, env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "qa-install-home-"));
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  const r = spawnSync("/bin/bash", [script, ...args], {
    encoding: "utf8",
    env: { PATH: stubPath(stubs), HOME: home, SHELL: "/bin/zsh", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, home };
}

const NODE_OK = 'echo "v22.13.0"';
const NPM_UNPUBLISHED = '[ "$1" = view ] && exit 1; exit 0';

describe("install.sh", () => {
  it("passes bash -n", () => {
    expect(spawnSync("/bin/bash", ["-n", script]).status).toBe(0);
  });

  it.skipIf(!hasShellcheck)("passes shellcheck", () => {
    const r = spawnSync("shellcheck", [script], { encoding: "utf8" });
    expect(r.stdout + r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("stops with clear instructions when Node.js is missing", () => {
    const r = install(["--dry-run", "--yes"], {});
    expect(r.code).toBe(1);
    expect(r.out).toContain("Node.js is not installed");
    expect(r.out).toContain("https://nodejs.org/en/download");
  });

  it("refuses Node.js older than 22.13", () => {
    const r = install(["--dry-run", "--yes"], { node: 'echo "v22.12.0"', npm: "exit 0" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("Found Node.js v22.12.0, which is too old");
  });

  it("offers the official Claude Code and Codex install commands when neither is installed", () => {
    const r = install(["--dry-run", "--yes", "--no-init"], { node: NODE_OK, npm: NPM_UNPUBLISHED, git: "" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("curl -fsSL https://claude.ai/install.sh | bash");
    expect(r.out).toContain("npm install -g @openai/codex");
  });

  it("builds from GitHub while the npm package is unpublished, and links the command", () => {
    const r = install(["--dry-run", "--yes", "--no-init"], {
      node: NODE_OK,
      npm: NPM_UNPUBLISHED,
      git: "",
      claude: 'echo "2.0.0 (Claude Code)"',
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Claude Code 2.0.0");
    expect(r.out).toContain("building from GitHub instead");
    expect(r.out).toContain("git clone --depth 1 --branch main https://github.com/Pvk1294/quietapply.git");
    expect(r.out).toContain(`ln -sf ${r.home}/.local/share/quietapply/src/dist/cli/index.js`);
    expect(r.out).toContain(`append to ${r.home}/.zshrc: export PATH="${r.home}/.local/bin:$PATH"`);
  });

  it("installs the npm package into its own prefix once it is published", () => {
    const r = install(["--dry-run", "--yes", "--no-init"], {
      node: NODE_OK,
      npm: '[ "$1" = view ] && echo 0.1.0; exit 0',
      codex: 'echo "codex-cli 0.50.0"',
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      `npm install --global --prefix ${r.home}/.local/share/quietapply --no-fund --no-audit quietapply`,
    );
    expect(r.out).toContain(`ln -sf ${r.home}/.local/share/quietapply/bin/quietapply`);
  });

  it("does not edit the shell profile when the bin folder is already on PATH", () => {
    const r = install(["--dry-run", "--yes", "--no-init", "--bin-dir", "/opt/qa-bin"], {
      node: NODE_OK,
      npm: NPM_UNPUBLISHED,
      git: "",
    });
    // /opt/qa-bin is not on the stub PATH, so the line is proposed; now put it on PATH.
    expect(r.out).toContain("append to");
    const home = mkdtempSync(join(tmpdir(), "qa-install-home-"));
    const p = stubPath({ node: NODE_OK, npm: NPM_UNPUBLISHED, git: "" });
    const again = spawnSync(
      "/bin/bash",
      [script, "--dry-run", "--yes", "--no-init", "--bin-dir", "/opt/qa-bin"],
      {
        encoding: "utf8",
        env: { PATH: `/opt/qa-bin:${p}`, HOME: home, SHELL: "/bin/zsh" },
      },
    );
    expect(again.stdout).not.toContain("append to");
  });

  it("rejects unknown options", () => {
    const r = install(["--bogus"], { node: NODE_OK });
    expect(r.code).toBe(1);
    expect(r.out).toContain("Unknown option: --bogus");
  });

  it("compares Node versions correctly", () => {
    const check = (v: string) =>
      spawnSync("/bin/bash", ["-c", `source "${script}"; version_ok "${v}" && echo yes || echo no`], {
        encoding: "utf8",
        env: { ...process.env, QUIETAPPLY_INSTALL_SOURCED: "1" },
      }).stdout.trim();
    expect(check("v22.13.0")).toBe("yes");
    expect(check("v22.12.9")).toBe("no");
    expect(check("v23.0.0")).toBe("yes");
    expect(check("v20.18.0")).toBe("no");
    expect(check("garbage")).toBe("no");
  });
});
