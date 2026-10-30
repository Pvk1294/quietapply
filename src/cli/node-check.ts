/**
 * The CLI's first import. Everything else ends up loading node:sqlite, and on an older Node.js that fails
 * with a raw ERR_UNKNOWN_BUILTIN_MODULE stack trace before any of our code runs. So this file imports
 * nothing and sticks to old syntax: it has to load and speak on any Node.js that can start the CLI at all.
 */
export const MIN_NODE = "22.13";

/** Node.js 22.13 is the first release where node:sqlite works without a flag. */
export function nodeTooOld(version: string): boolean {
  const [major, minor] = version.split(".").map(Number) as [number, number];
  const [minMajor, minMinor] = MIN_NODE.split(".").map(Number) as [number, number];
  return major < minMajor || (major === minMajor && minor < minMinor);
}

export function nodeTooOldMessage(version: string): string {
  return [
    `QuietApply needs Node.js ${MIN_NODE} or newer. This computer is running Node.js ${version}.`,
    "",
    "Install the LTS version of Node.js, whichever way you prefer:",
    "  - the installer from https://nodejs.org",
    "  - Homebrew: brew install node",
    "  - nvm: nvm install --lts",
    "",
    "Then open a new terminal, check it with `node --version`, and run the same command again.",
  ].join("\n");
}

if (nodeTooOld(process.versions.node)) {
  console.error(nodeTooOldMessage(process.versions.node));
  process.exit(1);
}
