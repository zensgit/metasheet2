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
  if (-not $Pm2Command) {
    $localPm2 = Join-Path $root 'node_modules\.bin\pm2.cmd'
    $Pm2Command = if (Test-Path -LiteralPath $localPm2 -PathType Leaf) { $localPm2 }
      else { (Get-Command pm2.cmd -CommandType Application | Select-Object -First 1).Source }
  }
  $pm2 = (Get-Item -LiteralPath $Pm2Command).FullName
  $proof = @(& (Join-Path $PSScriptRoot '03-live-env-check.ps1') -InstallRoot $root -Keys NODE_ENV -ExpectedPm2Command $pm2)
  if ($LASTEXITCODE -ne 0 -or $proof -cnotcontains 'LIVEENV_BACKEND target=verified') {
    'P3_SIGNOFF_RESTART status=STOP reason=backend_target_unconfirmed'
    exit 2
  }

  # PM2 restart-by-name uses the existing app definition. Updating the env or
  # starting the ecosystem file here would import the operator's shell again.
  $ErrorActionPreference = 'Continue'
  $LASTEXITCODE = $null
  & $pm2 restart metasheet-backend *> $null
  if ($LASTEXITCODE -ne 0) {
    'P3_SIGNOFF_RESTART status=STOP reason=pm2_restart_failed'
    exit 3
  }
  'P3_SIGNOFF_RESTART status=complete'
} catch {
  'P3_SIGNOFF_RESTART status=STOP reason=script_error'
  exit 3
}
