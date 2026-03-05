$ErrorActionPreference = "Stop"

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Error "npm is required. Install Node.js 20+ from https://nodejs.org/ and rerun."
  exit 1
}

Write-Host "Installing auramaxx globally..."
npm install -g auramaxx
Write-Host "Done. Run: auramaxx --help"
