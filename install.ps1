# QuietApply installer for Windows (PowerShell 5.1+).
#
#   irm https://raw.githubusercontent.com/Pvk1294/quietapply/main/install.ps1 | iex
#
# Checks Node.js 22.13+, Chrome or Edge, and Claude Code or Codex; installs QuietApply into
# %LOCALAPPDATA%\quietapply (no admin rights); adds its bin folder to your user PATH; starts `quietapply init`.
# Note: the scheduler (`quietapply schedule on`) supports macOS and Linux in v0.1; on Windows use Run now
# in the dashboard, or Task Scheduler by hand.
#
# Options when saved to a file:  .\install.ps1 -NoInit -FromSource -Ref main -DryRun

param(
  [switch]$NoInit,
  [switch]$FromSource,
  [switch]$DryRun,
  [string]$Ref = $(if ($env:QUIETAPPLY_REF) { $env:QUIETAPPLY_REF } else { "main" }),
  [string]$Prefix = $(if ($env:QUIETAPPLY_PREFIX) { $env:QUIETAPPLY_PREFIX } else { Join-Path $env:LOCALAPPDATA "quietapply" })
)

$ErrorActionPreference = "Stop"
$Repo = if ($env:QUIETAPPLY_REPO) { $env:QUIETAPPLY_REPO } else { "https://github.com/Pvk1294/quietapply.git" }
$Package = if ($env:QUIETAPPLY_PACKAGE) { $env:QUIETAPPLY_PACKAGE } else { "quietapply" }

function Step($m) { Write-Host ""; Write-Host "==> $m" -ForegroundColor White }
function Ok($m) { Write-Host "  [ok] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!] $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host ""; Write-Host "  [x] $m" -ForegroundColor Red; exit 1 }
function Run([string]$cmd, [string[]]$cmdArgs) {
  if ($DryRun) { Write-Host "  [dry-run] $cmd $($cmdArgs -join ' ')"; return }
  & $cmd @cmdArgs
  if ($LASTEXITCODE -ne 0) { Fail "$cmd failed (exit $LASTEXITCODE)" }
}
function Has($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }

Write-Host "QuietApply installer (Windows)"
if ($DryRun) { Write-Host "Dry run: nothing will be changed." }

Step "Node.js"
if (-not (Has "node")) {
  Warn "Node.js is not installed. QuietApply needs Node.js 22.13 or newer."
  Write-Host "    winget install OpenJS.NodeJS.LTS    or download it from https://nodejs.org/en/download"
  Fail "Install Node.js, open a new PowerShell window, and run this installer again."
}
$nodeVersion = (node --version).TrimStart("v")
$parts = $nodeVersion.Split(".")
if ([int]$parts[0] -lt 22 -or ([int]$parts[0] -eq 22 -and [int]$parts[1] -lt 13)) {
  Warn "Found Node.js $nodeVersion, which is too old."
  Write-Host "    winget upgrade OpenJS.NodeJS.LTS    or download it from https://nodejs.org/en/download"
  Fail "Update Node.js to 22.13+ first."
}
Ok "Node.js v$nodeVersion"

Step "Browser"
$browsers = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
)
$browser = $browsers | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if ($browser) { Ok "Found $browser" } else { Warn "Chrome or Edge not found. Install Chrome from https://www.google.com/chrome/" }

Step "AI: Claude Code or Codex"
$hasAi = $false
if (Has "claude") { Ok "Claude Code $(claude --version)"; $hasAi = $true }
if (Has "codex") { Ok "Codex $(codex --version)"; $hasAi = $true }
if (-not $hasAi) {
  Warn "Neither Claude Code nor Codex is installed. Official install commands:"
  Write-Host "    Claude Code:  irm https://claude.ai/install.ps1 | iex"
  Write-Host "    Codex:        npm install -g @openai/codex"
  $reply = Read-Host "  Install Claude Code now with its official installer? [y/N]"
  if ($reply -match "^(y|yes)$") {
    if ($DryRun) { Write-Host "  [dry-run] irm https://claude.ai/install.ps1 | iex" }
    else { Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression }
  }
}

Step "Installing QuietApply"
$published = $false
if (-not $FromSource) {
  npm view $Package version *> $null
  $published = ($LASTEXITCODE -eq 0)
}
if ($published) {
  Run "npm" @("install", "--global", "--prefix", $Prefix, "--no-fund", "--no-audit", $Package)
  $binDir = $Prefix
} else {
  if (-not $FromSource) { Warn "The npm package is not published yet; building from GitHub instead." }
  if (-not (Has "git")) { Fail "git is needed to build from source: winget install Git.Git" }
  $src = Join-Path $Prefix "src"
  if (Test-Path (Join-Path $src ".git")) {
    Run "git" @("-C", $src, "fetch", "--depth", "1", "origin", $Ref)
    Run "git" @("-C", $src, "checkout", "-q", "FETCH_HEAD")
  } else {
    Run "git" @("clone", "--depth", "1", "--branch", $Ref, $Repo, $src)
  }
  Run "npm" @("--prefix", $src, "ci", "--no-fund", "--no-audit")
  Run "npm" @("--prefix", $src, "run", "build")
  $binDir = Join-Path $Prefix "bin"
  if (-not $DryRun) {
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    $cli = Join-Path $src "dist\cli\index.js"
    Set-Content -Path (Join-Path $binDir "quietapply.cmd") -Value "@echo off`r`nnode `"$cli`" %*" -Encoding ASCII
  }
}
Ok "quietapply installed in $binDir"

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not ($userPath -split ";" | Where-Object { $_ -eq $binDir })) {
  if ($DryRun) { Write-Host "  [dry-run] add $binDir to the user PATH" }
  else { [Environment]::SetEnvironmentVariable("Path", "$binDir;$userPath", "User") }
  Ok "Added $binDir to your user PATH (new terminals pick it up)"
}
$env:Path = "$binDir;$env:Path"

Step "Done"
Ok "Your data will live in $HOME\.quietapply. Try it with fake data first: quietapply demo"
if (-not $NoInit) {
  if ($DryRun) { Write-Host "  [dry-run] quietapply init" } else { quietapply init }
}
