#requires -Version 5.1
# Target-shell regression tests for stock-preparation-onprem-acceptance.ps1.
#
# The packaged Windows path runs under Windows PowerShell 5.1, whose native stderr handling differs
# from pwsh 7. These tests must run with powershell.exe on windows-latest. A child that writes both
# stdout and stderr must still return its stdout and exact exit code while the runner's global
# ErrorActionPreference remains Stop.
$ErrorActionPreference = 'Stop'
$opsDir = Join-Path $PSScriptRoot '..'
$scriptPath = Join-Path $opsDir 'stock-preparation-onprem-acceptance.ps1'
$pass = 0
$fail = 0

function Check {
  param([string]$Name, [bool]$Ok)
  if ($Ok) {
    $script:pass++
    Write-Host "  PASS  $Name"
  } else {
    $script:fail++
    Write-Host "  FAIL  $Name"
  }
}

Check 'host is Windows PowerShell 5.1 Desktop' (
  $PSVersionTable.PSEdition -eq 'Desktop' -and
  $PSVersionTable.PSVersion.Major -eq 5 -and
  $PSVersionTable.PSVersion.Minor -eq 1
)

$root = Join-Path ([System.IO.Path]::GetTempPath()) ("t9accept_ps51_" + [guid]::NewGuid().ToString('N').Substring(0, 12))
$fakeSmoke = Join-Path $root 'fake-smoke.mjs'
$sentinel = 'PS51-STDERR-SENTINEL-4210'

try {
  New-Item -ItemType Directory -Path $root -Force | Out-Null
  . $scriptPath -PackagePath $root -DeployRoot $root *> $null
  $dummyToken = ConvertTo-SecureString 'dummy-not-a-real-token' -AsPlainText -Force

  Set-Content -LiteralPath $fakeSmoke -Encoding ASCII -Value @(
    "process.stderr.write('$sentinel\\n')"
    "process.stdout.write('mvpSmoke.pass=true\\n')"
    "process.stdout.write('auditActionsCovered=8/8\\n')"
    "process.stdout.write('selfScanClean=true\\n')"
    'process.exit(0)'
  )

  $zeroCapture = $null
  $zeroThrew = $false
  try {
    $zeroCapture = Invoke-SmokeCapture -NodeArgs @($fakeSmoke) -Token $dummyToken
  } catch {
    $zeroThrew = $true
  }

  Check 'stderr-writing exit-0 child does not abort capture' (-not $zeroThrew -and $null -ne $zeroCapture)
  Check 'exit-0 stdout summary is captured' (
    $null -ne $zeroCapture -and
    $zeroCapture.stdout -match 'mvpSmoke\.pass=true' -and
    $zeroCapture.stdout -match 'auditActionsCovered=8/8' -and
    $zeroCapture.stdout -match 'selfScanClean=true'
  )
  Check 'exit-0 stderr is excluded from stdout' ($null -ne $zeroCapture -and $zeroCapture.stdout -notmatch $sentinel)
  Check 'exit-0 code is preserved exactly' ($null -ne $zeroCapture -and $zeroCapture.exit -eq 0)
  Check 'exit-0 restores error policy and clears token env' (
    $ErrorActionPreference -eq 'Stop' -and -not (Test-Path Env:METASHEET_AUTH_TOKEN)
  )

  Set-Content -LiteralPath $fakeSmoke -Encoding ASCII -Value @(
    "process.stderr.write('$sentinel\\n')"
    "process.stdout.write('mvpSmoke.pass=true\\n')"
    "process.stdout.write('auditActionsCovered=8/8\\n')"
    "process.stdout.write('selfScanClean=true\\n')"
    'process.exit(7)'
  )

  $sevenCapture = $null
  $sevenThrew = $false
  try {
    $sevenCapture = Invoke-SmokeCapture -NodeArgs @($fakeSmoke) -Token $dummyToken
  } catch {
    $sevenThrew = $true
  }

  Check 'stderr-writing exit-7 child does not abort capture' (-not $sevenThrew -and $null -ne $sevenCapture)
  Check 'exit-7 stdout is captured and stderr remains excluded' (
    $null -ne $sevenCapture -and
    $sevenCapture.stdout -match 'mvpSmoke\.pass=true' -and
    $sevenCapture.stdout -notmatch $sentinel
  )
  Check 'exit-7 code is preserved exactly' ($null -ne $sevenCapture -and $sevenCapture.exit -eq 7)
  Check 'exit-7 restores error policy and clears token env' (
    $ErrorActionPreference -eq 'Stop' -and -not (Test-Path Env:METASHEET_AUTH_TOKEN)
  )
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item Env:METASHEET_AUTH_TOKEN -ErrorAction SilentlyContinue
}

if ($fail -gt 0) {
  Write-Host "FAILED: $fail check(s); $pass passed"
  exit 1
}

Write-Host "ALL POWERSHELL 5.1 CHECKS PASS ($pass/10)"
exit 0
