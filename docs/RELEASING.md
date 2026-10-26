# Releasing QuietApply

How to publish a version to npm so that `npx quietapply init` and the one-line installer use the
published package. Only the maintainer publishes; nothing in CI publishes on its own.

## What the package contains

`package.json` is set up for npm:

- `bin`: `quietapply` → `dist/cli/index.js` (npm makes it executable on install)
- `files`: `dist`, `data` (the starter company list), `prompts`, `playbooks`, `fixtures/ats` and
  `fixtures/persona` (the demo uses them; fake data only), `install.sh`, `install.ps1`, `README.md`, `LICENSE`
- `engines`: Node `>=22.13` (built-in SQLite)
- `prepack`: cleans `dist/` and runs `npm run build` (server and dashboard), so a tarball never ships stale files
- `prepublishOnly`: `npm run check` (lint, types, tests), so a failing build cannot be published
- `publishConfig.access`: `public`

## One-time setup

1. An npm account with two-factor authentication on: <https://www.npmjs.com/signup>, then
   `npm login` and check with `npm whoami`.
2. Check the name is still free: `npm view quietapply`. A `404` means it is free. If someone has taken
   it, pick another name in `package.json` (`name`), the README and `install.sh` (`QUIETAPPLY_PACKAGE`).
3. The one-line installer is fetched from
   `https://raw.githubusercontent.com/Pvk1294/quietapply/main/install.sh`. That URL only works once the
   repository has a `main` branch **and is public**. While the repo is private, `curl … | bash` returns 404.

## Each release

```bash
# 1. Start from a clean checkout of the branch you release
git switch main && git pull
npm ci

# 2. Optional but recommended: refresh the starter company list and review the diff
npm run build:server && npm run companies:verify
git diff --stat data/companies.json

# 3. Set the version (0.1.0-dev → 0.1.0 for the first release)
npm version 0.1.0 --no-git-tag-version

# 4. Check everything and look at what will be published
npm run check
npm pack --dry-run          # expect dist/, data/companies.json, prompts/, playbooks/, fixtures/, install.*

# 5. Try the tarball like a user would, in a throwaway prefix and data folder
npm pack --pack-destination /tmp/qa-release
npm install -g --prefix /tmp/qa-release/prefix /tmp/qa-release/quietapply-0.1.0.tgz
/tmp/qa-release/prefix/bin/quietapply --version
QUIETAPPLY_HOME=/tmp/qa-release/home /tmp/qa-release/prefix/bin/quietapply init --yes --provider fake
/tmp/qa-release/prefix/bin/quietapply demo        # dashboard on http://127.0.0.1:4777, Ctrl-C to stop

# 6. Commit, tag and publish
git commit -am "Release 0.1.0"
git tag v0.1.0
npm publish                 # asks for your 2FA code; add --otp=123456 to pass it directly
git push origin main --tags
```

For a test release that `npx quietapply` does not pick up by default, publish under another tag:
`npm version 0.2.0-beta.1 --no-git-tag-version && npm publish --tag next`
(install it with `npx quietapply@next init`).

## After publishing

```bash
npm view quietapply version                     # the new version
npx quietapply@latest --version                 # runs from the registry
curl -fsSL https://raw.githubusercontent.com/Pvk1294/quietapply/main/install.sh | bash -s -- --dry-run
```

The installer prefers the npm package as soon as `npm view quietapply` succeeds, and builds from GitHub
only until then (or with `--from-source`).

## If something goes wrong

- A broken release can be deprecated, not overwritten: `npm deprecate quietapply@0.1.0 "Broken, use 0.1.1"`,
  then publish a fixed patch version. `npm unpublish` is easy only within the first 72 hours, and a
  version number can never be reused once published, so prefer deprecating.
- Revert the version bump with `git checkout package.json package-lock.json` if you stop before publishing.

References: [npm publish](https://docs.npmjs.com/cli/commands/npm-publish),
[npm version](https://docs.npmjs.com/cli/commands/npm-version),
[unpublish policy](https://docs.npmjs.com/policies/unpublish),
[two-factor authentication](https://docs.npmjs.com/configuring-two-factor-authentication).
