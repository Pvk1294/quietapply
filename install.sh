#!/usr/bin/env bash
# QuietApply installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/Pvk1294/quietapply/main/install.sh | bash
#
# What it does, in order (nothing is installed without telling you first):
#   1. checks Node.js 22.13+ and says how to get it if it is missing
#   2. checks for Google Chrome or Microsoft Edge
#   3. checks for Claude Code or Codex and offers the official install command if neither is there
#   4. installs QuietApply into ~/.local/share/quietapply (no sudo; your global npm is not touched)
#   5. puts the `quietapply` command in ~/.local/bin and makes sure that folder is on your PATH
#   6. starts `quietapply init`
#
# Options (after `bash -s --` when piping):
#   --no-init        install only; do not start the setup wizard
#   --yes            no questions; skip optional installs (Claude Code / Codex) and the PATH edit prompt
#   --from-source    build from the GitHub repo instead of the npm package
#   --ref <branch>   git branch or tag for --from-source (default: main)
#   --prefix <dir>   where to install (default: ~/.local/share/quietapply)
#   --bin-dir <dir>  where to put the command (default: ~/.local/bin)
#   --dry-run        print what would be done without changing anything
#   --help
#
# Environment overrides: QUIETAPPLY_PREFIX, QUIETAPPLY_BIN_DIR, QUIETAPPLY_REF, QUIETAPPLY_REPO,
# QUIETAPPLY_PACKAGE (npm spec, e.g. quietapply@0.1.0).

set -euo pipefail

REPO="${QUIETAPPLY_REPO:-https://github.com/Pvk1294/quietapply.git}"
PACKAGE="${QUIETAPPLY_PACKAGE:-quietapply}"
REF="${QUIETAPPLY_REF:-main}"
PREFIX="${QUIETAPPLY_PREFIX:-$HOME/.local/share/quietapply}"
BIN_DIR="${QUIETAPPLY_BIN_DIR:-$HOME/.local/bin}"
NODE_MIN_MAJOR=22
NODE_MIN_MINOR=13

RUN_INIT=1
ASSUME_YES=0
FROM_SOURCE=0
DRY_RUN=0

if [ -t 1 ]; then
  BOLD=$'\033[1m' DIM=$'\033[2m' RED=$'\033[31m' GREEN=$'\033[32m' YELLOW=$'\033[33m' RESET=$'\033[0m'
else
  BOLD="" DIM="" RED="" GREEN="" YELLOW="" RESET=""
fi

say() { printf '%s\n' "$*"; }
step() { printf '\n%s==>%s %s%s\n' "$BOLD" "$RESET" "$BOLD$*" "$RESET"; }
ok() { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
fail() {
  printf '\n%s✗ %s%s\n' "$RED" "$*" "$RESET" >&2
  exit 1
}

# Run a command, or only print it with --dry-run.
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '  %s[dry-run]%s %s\n' "$DIM" "$RESET" "$*"
  else
    "$@"
  fi
}

usage() {
  cat <<'USAGE'
QuietApply installer (macOS / Linux)

  curl -fsSL https://raw.githubusercontent.com/Pvk1294/quietapply/main/install.sh | bash
  curl -fsSL https://raw.githubusercontent.com/Pvk1294/quietapply/main/install.sh | bash -s -- --no-init

Options:
  --no-init        install only; do not start the setup wizard
  --yes            no questions; skip optional installs and add the PATH line
  --from-source    build from the GitHub repo instead of the npm package
  --ref <branch>   git branch or tag for --from-source (default: main)
  --prefix <dir>   where to install (default: ~/.local/share/quietapply)
  --bin-dir <dir>  where to put the command (default: ~/.local/bin)
  --dry-run        print what would be done without changing anything
USAGE
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --no-init) RUN_INIT=0 ;;
      --yes | -y) ASSUME_YES=1 ;;
      --from-source) FROM_SOURCE=1 ;;
      --ref)
        [ $# -ge 2 ] || fail "--ref needs a value"
        REF="$2"
        shift
        ;;
      --prefix)
        [ $# -ge 2 ] || fail "--prefix needs a value"
        PREFIX="$2"
        shift
        ;;
      --bin-dir)
        [ $# -ge 2 ] || fail "--bin-dir needs a value"
        BIN_DIR="$2"
        shift
        ;;
      --dry-run) DRY_RUN=1 ;;
      --help | -h)
        usage
        exit 0
        ;;
      *) fail "Unknown option: $1 (try --help)" ;;
    esac
    shift
  done
}

# Questions read from the terminal, because stdin is the script itself under `curl | bash`.
has_tty() { [ "$ASSUME_YES" = 0 ] && { true </dev/tty; } 2>/dev/null; }

ask_yes_no() {
  # ask_yes_no "Question?" default(y|n)
  local prompt="$1" default="$2" reply
  if ! has_tty; then
    [ "$default" = y ]
    return
  fi
  local hint="[y/N]"
  [ "$default" = y ] && hint="[Y/n]"
  printf '  %s %s ' "$prompt" "$hint" >/dev/tty
  read -r reply </dev/tty || reply=""
  reply="$(printf '%s' "$reply" | tr '[:upper:]' '[:lower:]')"
  [ -z "$reply" ] && reply="$default"
  [ "$reply" = y ] || [ "$reply" = yes ]
}

detect_os() {
  case "$(uname -s)" in
    Darwin) OS=macos ;;
    Linux) OS=linux ;;
    *) fail "This installer supports macOS and Linux. On Windows, use install.ps1 (PowerShell)." ;;
  esac
}

# version_ok "22.13.1" → true when it is at least NODE_MIN_MAJOR.NODE_MIN_MINOR
version_ok() {
  local v="${1#v}" major minor
  major="${v%%.*}"
  minor="${v#*.}"
  minor="${minor%%.*}"
  case "$major$minor" in *[!0-9]*) return 1 ;; esac
  [ "$major" -gt "$NODE_MIN_MAJOR" ] || { [ "$major" -eq "$NODE_MIN_MAJOR" ] && [ "$minor" -ge "$NODE_MIN_MINOR" ]; }
}

node_help() {
  say ""
  say "  QuietApply needs Node.js $NODE_MIN_MAJOR.$NODE_MIN_MINOR or newer (it uses Node's built-in SQLite)."
  say "  Pick one way to install it, then run this installer again:"
  if [ "$OS" = macos ]; then
    say "    • Homebrew:  brew install node"
  else
    say "    • Your package manager may ship an old Node; prefer one of the options below."
  fi
  say "    • nvm:       curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && nvm install 22"
  say "    • fnm:       curl -fsSL https://fnm.vercel.app/install | bash && fnm install 22"
  say "    • Installer: https://nodejs.org/en/download"
}

check_node() {
  step "Node.js"
  if ! command -v node >/dev/null 2>&1; then
    warn "Node.js is not installed."
    node_help
    fail "Install Node.js $NODE_MIN_MAJOR.$NODE_MIN_MINOR+ first."
  fi
  local v
  v="$(node --version 2>/dev/null || echo unknown)"
  if ! version_ok "$v"; then
    warn "Found Node.js $v, which is too old."
    node_help
    fail "Update Node.js to $NODE_MIN_MAJOR.$NODE_MIN_MINOR+ first."
  fi
  command -v npm >/dev/null 2>&1 || fail "npm is missing (it normally comes with Node.js). Reinstall Node.js."
  ok "Node.js $v"
}

find_browser() {
  local candidates=()
  if [ "$OS" = macos ]; then
    candidates=(
      "/Applications/Google Chrome.app"
      "$HOME/Applications/Google Chrome.app"
      "/Applications/Microsoft Edge.app"
      "$HOME/Applications/Microsoft Edge.app"
    )
    local c
    for c in "${candidates[@]}"; do
      [ -d "$c" ] && {
        printf '%s' "$c"
        return 0
      }
    done
  else
    local b
    for b in google-chrome google-chrome-stable microsoft-edge microsoft-edge-stable chromium chromium-browser; do
      command -v "$b" >/dev/null 2>&1 && {
        command -v "$b"
        return 0
      }
    done
  fi
  return 1
}

check_browser() {
  step "Browser"
  local found
  if found="$(find_browser)"; then
    ok "Found $found"
  else
    warn "Google Chrome or Microsoft Edge was not found."
    say "    QuietApply drives its own Chrome profile (~/.quietapply/browser-profile), never your everyday browser."
    say "    Install Chrome from https://www.google.com/chrome/ or Edge from https://www.microsoft.com/edge"
    say "    (you can finish installing QuietApply now and add the browser later)."
  fi
}

check_ai() {
  step "AI: Claude Code or Codex"
  local have=0
  if command -v claude >/dev/null 2>&1; then
    ok "Claude Code $(claude --version 2>/dev/null | head -n 1)"
    have=1
  fi
  if command -v codex >/dev/null 2>&1; then
    ok "Codex $(codex --version 2>/dev/null | head -n 1)"
    have=1
  fi
  [ "$have" = 1 ] && return 0

  warn "Neither Claude Code nor Codex is installed. QuietApply runs on one of them (your plan or an API key)."
  say "    Official install commands:"
  say "      Claude Code:  curl -fsSL https://claude.ai/install.sh | bash"
  say "      Codex:        npm install -g @openai/codex"
  if ask_yes_no "Install Claude Code now with its official installer?" n; then
    run bash -c "curl -fsSL https://claude.ai/install.sh | bash"
    ok "Claude Code installed. Sign in later by running: claude"
  elif ask_yes_no "Install Codex now (npm install -g @openai/codex)?" n; then
    run npm install -g @openai/codex
    ok "Codex installed. Sign in later with: codex login"
  else
    say "    Skipped. The setup wizard will remind you; you can also try the demo without any AI."
  fi
}

package_published() {
  [ "$FROM_SOURCE" = 1 ] && return 1
  npm view "$PACKAGE" version >/dev/null 2>&1
}

install_from_npm() {
  say "  Installing $PACKAGE from npm into $PREFIX"
  run npm install --global --prefix "$PREFIX" --no-fund --no-audit "$PACKAGE"
  ENTRY="$PREFIX/bin/quietapply"
}

install_from_source() {
  command -v git >/dev/null 2>&1 || fail "git is needed to build from source. Install git and try again."
  local src="$PREFIX/src"
  if [ -d "$src/.git" ]; then
    say "  Updating the source in $src ($REF)"
    run git -C "$src" fetch --depth 1 origin "$REF"
    run git -C "$src" checkout -q FETCH_HEAD
  else
    say "  Cloning $REPO ($REF) into $src"
    run mkdir -p "$PREFIX"
    run git clone --depth 1 --branch "$REF" "$REPO" "$src"
  fi
  say "  Building (a minute or two)"
  run npm --prefix "$src" ci --no-fund --no-audit
  run npm --prefix "$src" run build
  run chmod +x "$src/dist/cli/index.js"
  ENTRY="$src/dist/cli/index.js"
}

install_quietapply() {
  step "Installing QuietApply"
  if package_published; then
    install_from_npm
  else
    [ "$FROM_SOURCE" = 1 ] || warn "The npm package is not published yet; building from GitHub instead."
    install_from_source
  fi
  run mkdir -p "$BIN_DIR"
  run ln -sf "$ENTRY" "$BIN_DIR/quietapply"
  ok "quietapply → $BIN_DIR/quietapply"
}

shell_rc() {
  case "$(basename "${SHELL:-bash}")" in
    zsh) printf '%s' "$HOME/.zshrc" ;;
    fish) printf '%s' "$HOME/.config/fish/config.fish" ;;
    *) if [ "$OS" = macos ]; then printf '%s' "$HOME/.bash_profile"; else printf '%s' "$HOME/.bashrc"; fi ;;
  esac
}

ensure_path() {
  case ":$PATH:" in *":$BIN_DIR:"*) return 0 ;; esac
  local rc line
  rc="$(shell_rc)"
  if [ "$(basename "$rc")" = config.fish ]; then
    line="fish_add_path $BIN_DIR"
  else
    line="export PATH=\"$BIN_DIR:\$PATH\""
  fi
  if [ -f "$rc" ] && grep -qsF "$BIN_DIR" "$rc"; then
    PATH_NOTE="Open a new terminal (or run: source $rc) to use the quietapply command."
    return 0
  fi
  if [ "$ASSUME_YES" = 1 ] || ask_yes_no "Add $BIN_DIR to your PATH in $rc?" y; then
    if [ "$DRY_RUN" = 1 ]; then
      printf '  %s[dry-run]%s append to %s: %s\n' "$DIM" "$RESET" "$rc" "$line"
    else
      mkdir -p "$(dirname "$rc")"
      printf '\n# Added by the QuietApply installer\n%s\n' "$line" >>"$rc"
    fi
    PATH_NOTE="Open a new terminal (or run: source $rc) to use the quietapply command."
  else
    PATH_NOTE="Add this line to your shell profile to use the quietapply command: $line"
  fi
}

main() {
  parse_args "$@"
  detect_os
  say "${BOLD}QuietApply installer${RESET} ${DIM}(macOS / Linux)${RESET}"
  [ "$DRY_RUN" = 1 ] && say "${DIM}Dry run: nothing will be changed.${RESET}"
  check_node
  check_browser
  check_ai
  install_quietapply
  PATH_NOTE=""
  ensure_path
  export PATH="$BIN_DIR:$PATH"

  step "Done"
  ok "QuietApply is installed. Your data will live in ~/.quietapply (readable only by you)."
  [ -n "$PATH_NOTE" ] && say "  $PATH_NOTE"
  say "  Try it with fake data first:  quietapply demo"

  if [ "$RUN_INIT" = 1 ]; then
    if has_tty; then
      step "Starting setup: quietapply init"
      if [ "$DRY_RUN" = 1 ]; then
        run quietapply init
      else
        # Give the wizard the real terminal (stdin here is the piped script).
        quietapply init </dev/tty
      fi
    else
      say "  Next: run  quietapply init  in a terminal to set it up."
    fi
  fi
}

# Allow tests to source the functions without running the installer.
if [ "${QUIETAPPLY_INSTALL_SOURCED:-0}" != 1 ]; then
  main "$@"
fi
