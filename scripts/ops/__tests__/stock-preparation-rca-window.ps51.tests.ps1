#requires -Version 5.1
$ErrorActionPreference = 'Stop'
$opsDir = Join-Path $PSScriptRoot '..'
$scriptPath = Join-Path $opsDir 'stock-preparation-rca-window.ps1'
$pass = 0
$fail = 0

function Check {
  param([string]$Name, [bool]$Ok)
  if ($Ok) { $script:pass++; Write-Host "  PASS  $Name" }
  else { $script:fail++; Write-Host "  FAIL  $Name" }
}

Check 'host is Windows PowerShell 5.1 Desktop' (
  $PSVersionTable.PSEdition -eq 'Desktop' -and
  $PSVersionTable.PSVersion.Major -eq 5 -and
  $PSVersionTable.PSVersion.Minor -eq 1
)

. $scriptPath
$root = Join-Path ([System.IO.Path]::GetTempPath()) ("rca_window_ps51_" + [guid]::NewGuid().ToString('N'))
try {
  New-Item -ItemType Directory -Path $root | Out-Null
  $script:PreparedPm2Helper = Join-Path $opsDir 'stock-preparation-rca-window-pm2-sample.mjs'
  $fixture = Join-Path $root 'pm2-fixture.mjs'
  Set-Content -LiteralPath $fixture -Encoding ASCII -NoNewline -Value @'
import fs from "node:fs"
const flag = process.env.MULTITABLE_STOCK_PREP_PLM_AUTOPERSIST_ENABLED || ""
const leaked = fs.existsSync(process.argv[2] || "") ? "present" : ""
process.stdout.write(JSON.stringify([{
  name: "metasheet-backend",
  pm2_env: {
    status: "online",
    restart_time: 2,
    pm_uptime: 1000,
    env: {
      Path: "a",
      PATH: "b",
      multitable_stock_prep_plm_autopersist_enabled: flag,
      metasheet_auth_token: leaked
    }
  }
}]))
'@
  $pm2Shim = Join-Path $root 'pm2.cmd'
  $leakMarker = Join-Path $root 'leak.marker'
  Set-Content -LiteralPath $pm2Shim -Encoding ASCII -Value @"
@echo off
if "%1"=="jlist" (
  echo PS51-RCA-PM2-STDERR 1>&2
  node "$fixture" "$leakMarker"
  exit /b %ERRORLEVEL%
)
if "%1"=="restart" (
  echo PS51-RCA-PM2-STDERR 1>&2
  exit /b 0
)
exit /b 2
"@
  $oldPath = $env:Path
  $env:Path = "$root;$oldPath"

  $env:MULTITABLE_STOCK_PREP_PLM_AUTOPERSIST_ENABLED = 'true'
  $sampleOn = Get-Pm2Sample
  Check 'stderr-writing PM2 native shim does not abort projection on PowerShell 5.1' (
    $null -ne $sampleOn -and $ErrorActionPreference -eq 'Stop'
  )
  Check 'case-variant true flag is observed on the target shell' (
    $null -ne $sampleOn -and $sampleOn.plmAutoPersistEnabledTrue -eq $true
  )
  Check 'Path/PATH duplication does not break the projection' (
    $null -ne $sampleOn -and $sampleOn.state -eq 'online'
  )

  Set-Content -LiteralPath $leakMarker -Encoding ASCII -Value 'present'
  $leaked = Get-Pm2Sample
  Check 'case-variant token presence is detected on the target shell' (
    $null -ne $leaked -and $leaked.authTokenNonEmpty -eq $true
  )
  Remove-Item -LiteralPath $leakMarker -Force

  $script:StableOnlineSeconds = 0
  $script:Sleep = { param([int]$Seconds) }
  $on = Invoke-Pm2RestartStable -ExpectedFlagTrue $true
  Check 'stderr-writing PM2 native shim preserves ON restart exit and policy' (
    $on.ok -and $ErrorActionPreference -eq 'Stop'
  )
  $env:MULTITABLE_STOCK_PREP_PLM_AUTOPERSIST_ENABLED = 'false'
  $off = Invoke-Pm2RestartStable -ExpectedFlagTrue $false
  Check 'stderr-writing PM2 native shim preserves OFF restart exit and policy' (
    $off.ok -and $ErrorActionPreference -eq 'Stop'
  )

  $fakeSmoke = Join-Path $root 'fake-smoke.mjs'
  Set-Content -LiteralPath $fakeSmoke -Encoding ASCII -NoNewline -Value @'
process.stderr.write("PS51-RCA-WINDOW-STDERR\n")
process.stdout.write("token=" + Boolean(process.env.METASHEET_AUTH_TOKEN) + "\n")
process.stdout.write("config=" + process.argv.includes("cfg-ps51") + "\n")
'@
  $script:PreparedExtendedHelper = $fakeSmoke
  $script:SmokeInvocationCount = 0
  $token = ConvertTo-SecureString 'token-ps51' -AsPlainText -Force
  $config = ConvertTo-SecureString 'cfg-ps51' -AsPlainText -Force
  $capture = $null
  $threw = $false
  try {
    $capture = Invoke-SmokeCapture -Token $token -ConfigReference $config -Origin 'http://127.0.0.1:1' -Tenant 'tenant' -Workspace ''
  } catch {
    $threw = $true
  }
  Check 'stderr-writing smoke child does not abort capture on PowerShell 5.1' (-not $threw -and $null -ne $capture)
  Check 'target-shell capture preserves stdout and exit 0' (
    $capture.exit -eq 0 -and $capture.stdout -match 'token=true' -and $capture.stdout -match 'config=true'
  )
  Check 'target-shell capture excludes child stderr' ($capture.stdout -notmatch 'PS51-RCA-WINDOW-STDERR')
  Check 'target-shell capture restores policy and clears token carriers' (
    $ErrorActionPreference -eq 'Stop' -and (Test-TokenCarriersEmpty)
  )
} finally {
  Remove-Item Env:MULTITABLE_STOCK_PREP_PLM_AUTOPERSIST_ENABLED -ErrorAction SilentlyContinue
  Remove-TokenCarriers
  if ($oldPath) { $env:Path = $oldPath }
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "stock-preparation RC-A window PowerShell 5.1: $pass passed, $fail failed"
if ($fail -gt 0) { exit 1 }
