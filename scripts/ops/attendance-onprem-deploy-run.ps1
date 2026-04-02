param(
  [string]$RootDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$RunLabel = 'run'
)

$ErrorActionPreference = 'Stop'
$resolvedRoot = (Resolve-Path $RootDir).Path
Set-Location $resolvedRoot

function Require-Command {
  param([string]$Name)

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing required command: $Name"
  }
}

Require-Command -Name 'node'
Require-Command -Name 'pnpm'

if (-not (Test-Path (Join-Path $resolvedRoot 'node_modules'))) {
  & pnpm install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) {
    throw 'pnpm install failed'
  }
}

$migratePath = Join-Path $resolvedRoot 'packages\core-backend\dist\src\db\migrate.js'
if (-not (Test-Path $migratePath)) {
  throw "Missing backend migration entrypoint: $migratePath"
}

& node $migratePath
if ($LASTEXITCODE -ne 0) {
  throw 'database migration failed'
}

$startScript = Join-Path $resolvedRoot 'scripts\ops\attendance-onprem-start-pm2.ps1'
& $startScript -RootDir $resolvedRoot
if ($LASTEXITCODE -ne 0) {
  throw 'pm2 startup failed'
}

Write-Host "[attendance-onprem-deploy-run] Deployment finished for $RunLabel"
