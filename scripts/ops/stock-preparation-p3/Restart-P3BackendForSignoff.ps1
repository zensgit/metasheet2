# Windows PowerShell 5.1. Run after a successful apply/rollback from the same
# account and PM2_HOME. Keep the environment saved by the release startup.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$InstallRoot,
  [string]$Pm2Command
)

$ErrorActionPreference = 'Stop'
try {
  $root = (Get-Item -LiteralPath $InstallRoot).FullName
  . (Join-Path $PSScriptRoot 'P3-Pm2Resolution.ps1')
  $resolution = Resolve-P3Pm2 $root
  if (-not $resolution.Command) {
    'P3_SIGNOFF_RESTART status=STOP reason=pm2_not_found'
    exit 2
  }
  $pm2 = if ($Pm2Command) { (Get-Item -LiteralPath $Pm2Command).FullName } else { $resolution.Command }
  $proof = @(& (Join-Path $PSScriptRoot '03-live-env-check.ps1') -InstallRoot $root -Keys NODE_ENV -ExpectedPm2Command $pm2)
  if ($LASTEXITCODE -ne 0 -or $proof -cnotcontains 'LIVEENV_BACKEND target=verified') {
    'P3_SIGNOFF_RESTART status=STOP reason=backend_target_unconfirmed'
    exit 2
  }

  # PM2 restart-by-name uses the existing app definition. Updating the env or
  # starting the ecosystem file here would import the operator's shell again.
  $ErrorActionPreference = 'Continue'
  $LASTEXITCODE = $null
  $previousPath = $env:PATH
  try {
    $env:PATH = $resolution.ToolPath
    & $pm2 restart metasheet-backend *> $null
  } finally {
    $env:PATH = $previousPath
  }
  if ($LASTEXITCODE -ne 0) {
    'P3_SIGNOFF_RESTART status=STOP reason=pm2_restart_failed'
    exit 3
  }
  'P3_SIGNOFF_RESTART status=complete'
} catch {
  'P3_SIGNOFF_RESTART status=STOP reason=script_error'
  exit 3
}
