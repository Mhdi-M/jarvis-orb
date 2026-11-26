# Jarvis installer (Windows)
#   irm https://raw.githubusercontent.com/Mhdi-M/jarvis-orb/main/install.ps1 | iex
#   or:  .\install.ps1 -Dir D:\tools\jarvis
#
# Installs the repo, the `jarvis` command, (optionally) Hermes, then runs the
# setup probe so the machine's own free/paid models are discovered and ranked.
param(
  [string]$Dir = "$env:LOCALAPPDATA\jarvis",
  [switch]$NoHermes,
  [switch]$NoProbe
)

$ErrorActionPreference = "Stop"
$Repo = if ($env:JARVIS_REPO) { $env:JARVIS_REPO } else { "https://github.com/Mhdi-M/jarvis-orb.git" }
$RawBase = "https://raw.githubusercontent.com/Mhdi-M/jarvis-orb/main"

function Say($m) { Write-Host "  $m" }
function Fail($m) { Write-Host "  x $m" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "Jarvis installer" -ForegroundColor Cyan
Write-Host ""

# --- prerequisites -----------------------------------------------------------
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail "Node.js 20+ is required. Install it with: winget install OpenJS.NodeJS.LTS"
}
$nodeVer = (node -v).TrimStart("v").Split(".")[0]
if ([int]$nodeVer -lt 20) { Fail "Node 20+ required (found $(node -v))" }

$hasGit = [bool](Get-Command git -ErrorAction SilentlyContinue)

# --- fetch the repo ----------------------------------------------------------
if (Test-Path (Join-Path $Dir ".git")) {
  Say "updating $Dir"
  if ($hasGit) { git -C $Dir pull --ff-only 2>&1 | Out-Null }
} else {
  if ($hasGit) {
    Say "cloning into $Dir"
    New-Item -ItemType Directory -Force -Path (Split-Path $Dir) | Out-Null
    git clone --depth 1 $Repo $Dir 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "git clone failed. Check the URL and your connection." }
  } else {
    Say "git not found - downloading the archive instead"
    $zip = Join-Path $env:TEMP "jarvis-orb.zip"
    Invoke-WebRequest "$RawBase/archive/refs/heads/main.zip" -OutFile $zip
    $tmp = Join-Path $env:TEMP ("jarvis-unzip-" + [guid]::NewGuid().ToString("N"))
    Expand-Archive $zip -DestinationPath $tmp -Force
    $inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
    New-Item -ItemType Directory -Force -Path $Dir | Out-Null
    Copy-Item (Join-Path $inner.FullName "*") $Dir -Recurse -Force
    Remove-Item $tmp -Recurse -Force
  }
}
if (-not (Test-Path (Join-Path $Dir "cli\jarvis.js"))) { Fail "install incomplete: cli/jarvis.js missing in $Dir" }
Say "repo ok: $Dir"

# --- hermes (the brain Jarvis drives) ----------------------------------------
$hermesExe = Join-Path $env:LOCALAPPDATA "hermes\hermes-agent\.hermes\bin\hermes.exe"
$haveHermes = Test-Path $hermesExe
if (-not $haveHermes -and -not $NoHermes) {
  $bash = Get-Command bash -ErrorAction SilentlyContinue
  if ($bash) {
    Say "installing Hermes with the official installer..."
    try {
      & bash -lc "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash" 2>&1 | Out-Null
    } catch { }
    $haveHermes = Test-Path $hermesExe
  }
  if (-not $haveHermes) {
    Say "Hermes is not installed. Jarvis still runs with the local Ollama model."
    Say "Install Hermes later with:  bash -lc 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash'"
  }
} elseif ($haveHermes) { Say "hermes found" }

# --- shims -------------------------------------------------------------------
$bin = Join-Path $env:LOCALAPPDATA "jarvis\bin"
New-Item -ItemType Directory -Force -Path $bin | Out-Null
$js = (Join-Path $Dir "cli\jarvis.js") -replace "/", "\"
@"
@echo off
node "$js" %*
"@ | Set-Content -Encoding ASCII (Join-Path $bin "jarvis.cmd")
@"
#!/usr/bin/env bash
exec node "$($js -replace '\\','/')" "`$@"
"@ | Set-Content -Encoding ASCII (Join-Path $bin "jarvis")

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$bin*") {
  [Environment]::SetEnvironmentVariable("Path", ($userPath.TrimEnd(";") + ";" + $bin), "User")
  $env:Path = $env:Path + ";" + $bin
  Say "added $bin to the user PATH (open a new terminal to pick it up)"
}
Say "command installed: $bin\jarvis.cmd"

# --- setup -------------------------------------------------------------------
$probeArg = if ($NoProbe) { "--no-probe" } else { "" }
Say "probing this machine's models..."
& node (Join-Path $Dir "cli\jarvis.js") --setup $probeArg

Write-Host ""
Write-Host "Done. Type:  jarvis" -ForegroundColor Green
Write-Host "Then:        /models   /perf   /security   /help" -ForegroundColor DarkGray
Write-Host ""
