# Self-contained installer for DocGraph on Windows / PowerShell.
# Mirrors the bash installer: downloads via npm and exposes `docgraph`,
# `docgraph-mcp`, and `docgraph-install` on the user's PATH.
#
# Usage:
#   irm https://raw.githubusercontent.com/carrilloapps/docgraph/main/install.ps1 | iex
#   $env:VERSION='1.2.0'; irm ... | iex
#
[CmdletBinding()]
param(
    [string]$Version = $(if ($env:VERSION) { $env:VERSION } else { 'latest' }),
    [string]$Prefix = $(if ($env:PREFIX) { $env:PREFIX } else { "$HOME\.docgraph" }),
    [string]$BinDir = $(if ($env:BIN_DIR) { $env:BIN_DIR } else { "$HOME\.local\bin" })
)
$ErrorActionPreference = 'Stop'

function Say([string]$msg) { Write-Host "[docgraph] $msg" }

Say "Installing DocGraph (version: $Version) to $Prefix"

New-Item -ItemType Directory -Force -Path $Prefix | Out-Null
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Say "npm is required. Get it from https://nodejs.org"
    exit 1
}

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
    Push-Location $tmp
    if ($Version -eq 'latest') {
        npm install --prefix=. "@carrilloapps/docgraph" | Out-Null
    } else {
        npm install --prefix=. "@carrilloapps/docgraph@$Version" | Out-Null
    }
    if ($LASTEXITCODE -ne 0) {
        throw "npm install failed with exit code $LASTEXITCODE"
    }
    Copy-Item -Path "$tmp\node_modules\@carrilloapps\docgraph\*" -Destination $Prefix -Recurse -Force
} finally {
    Pop-Location
    Remove-Item -Recurse -Force $tmp
}

# Create .cmd shims into the user's bin dir. We use .cmd shims on Windows
# because `npm exec`/PATH lookups prefer them over the raw .js entry files.
# Each shim is only written when its compiled entry point exists, mirroring
# install.sh's per-binary existence checks.
$sourceCli = Join-Path $Prefix 'dist\presentation\cli\cli.js'
$sourceMcp = Join-Path $Prefix 'dist\presentation\mcp\server.js'
$sourceInstall = Join-Path $Prefix 'dist\presentation\installer\installer.js'
$destCli = Join-Path $BinDir 'docgraph.cmd'
$destMcp = Join-Path $BinDir 'docgraph-mcp.cmd'
$destInstall = Join-Path $BinDir 'docgraph-install.cmd'

if (Test-Path $sourceCli) {
    @"
@echo off
node "$sourceCli" %*
"@ | Set-Content -Path $destCli
}

if (Test-Path $sourceMcp) {
    @"
@echo off
node "$sourceMcp" serve %*
"@ | Set-Content -Path $destMcp
}

if (Test-Path $sourceInstall) {
    @"
@echo off
node "$sourceInstall" %*
"@ | Set-Content -Path $destInstall
}

Say "Installed to $BinDir"
Say "Add '$BinDir' to PATH if not already, then run 'docgraph-install' to wire DocGraph into your AI agents."
