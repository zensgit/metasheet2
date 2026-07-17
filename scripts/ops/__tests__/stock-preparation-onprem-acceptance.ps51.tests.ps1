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
    "process.stderr.write('$sentinel\n')"
    "process.stdout.write('mvpSmoke.pass=true\n')"
    "process.stdout.write('auditActionsCovered=8/8\n')"
    "process.stdout.write('selfScanClean=true\n')"
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
    "process.stderr.write('$sentinel\n')"
    "process.stdout.write('mvpSmoke.pass=true\n')"
    "process.stdout.write('auditActionsCovered=8/8\n')"
    "process.stdout.write('selfScanClean=true\n')"
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

  # corrective-5: a non-zero smoke that writes bounded diagnostic lines to stdout (and noise to stderr)
  # must have its diagnostics captured and parseable under Windows PowerShell 5.1, stderr discarded, exit
  # preserved exactly. This is the target-shell coverage for the diagnostic contract.
  Set-Content -LiteralPath $fakeSmoke -Encoding ASCII -Value @(
    "process.stderr.write('$sentinel\n')"
    "process.stdout.write('mvpSmoke.pass=false\n')"
    "process.stdout.write('failureClass=CHECK_FAILED\n')"
    "process.stdout.write('lastCompletedPhase=SYNC_PERSIST\n')"
    "process.stdout.write('firstFailedCheck=PROVISIONING\n')"
    "process.stdout.write('failedCheckCount=3\n')"
    "process.stdout.write('responseLeakScanStatus=NOT_RUN\n')"
    'process.exit(1)'
  )
  $diagCapture = Invoke-SmokeCapture -NodeArgs @($fakeSmoke) -Token $dummyToken
  $diagOutcome = Test-SmokeOutcome $diagCapture.stdout
  Check 'exit-1 diagnostic stdout is captured, stderr excluded, exit preserved' (
    $null -ne $diagCapture -and $diagCapture.exit -eq 1 -and $diagCapture.stdout -notmatch $sentinel
  )
  Check 'exit-1 diagnostics parse to the fixed enums under Windows PowerShell 5.1' (
    $diagOutcome.failureClass -eq 'CHECK_FAILED' -and
    $diagOutcome.lastCompletedPhase -eq 'SYNC_PERSIST' -and
    $diagOutcome.firstFailedCheck -eq 'PROVISIONING' -and
    $diagOutcome.failedCheckCount -eq '3' -and
    $diagOutcome.responseLeakScanStatus -eq 'NOT_RUN'
  )
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item Env:METASHEET_AUTH_TOKEN -ErrorAction SilentlyContinue
}


# ── corrective-6: token-hygiene projection + verdict under REAL Windows PowerShell 5.1 ───────────
# (PSObject.Properties indexing, [bool] typing, function shim, native-pipeline BOM normalization,
# ConvertFrom-Json of the 5-key sample). Desktop-gated: on any other host the suite ALREADY fails
# loudly at the host check above, so this can never green-skip.
if ($PSVersionTable.PSEdition -eq 'Desktop') {
  $hygieneDir = Join-Path ([System.IO.Path]::GetTempPath()) ("t9ps51_pm2_" + [guid]::NewGuid().ToString('N').Substring(0, 12))
  New-Item -ItemType Directory -Path $hygieneDir | Out-Null
  try {
    # Keep the generated Node fixture byte-stable across Desktop and Core hosts.
    $hygieneFixture = Join-Path $hygieneDir 'pm2-fixture.mjs'
    Set-Content -Path $hygieneFixture -Encoding ASCII -Value @'
#!/usr/bin/env node
if (process.argv[2] !== 'jlist') process.exit(2)
process.stdout.write(process.env.T9_PS51_JLIST || '')
'@ -NoNewline
    # A FUNCTION shim (not a PATH .cmd): PowerShell resolves functions ahead of external commands
    # and without PATH-cache refresh semantics, which differ between WinPS 5.1 and pwsh — the
    # runner's own `& pm2` call inside Get-Pm2Sample resolves to this shim deterministically.
    $script:T9Ps51HygieneFixture = $hygieneFixture
    function script:pm2 {
      param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Pm2Args)
      & node $script:T9Ps51HygieneFixture @Pm2Args
    }
    try {
      $env:T9_PS51_JLIST = '[{"name":"metasheet-backend","pm2_env":{"status":"online","restart_time":3,"pm_uptime":1000,"env":{"Path":"first","PATH":"second","metasheet_admin_token":"LEAKED-PS51-9911"}}}]'
      $leakSample = Get-Pm2Sample
      Check 'ps51 hygiene: case-variant admin token projects to adminTokenNonEmpty=true through the 5.1 pipeline' (
        $null -ne $leakSample -and $leakSample.adminTokenNonEmpty -eq $true -and $leakSample.authTokenNonEmpty -eq $false
      )
      $leakVerdict = Test-Pm2TokenHygieneSample $leakSample
      Check 'ps51 hygiene: leaked sample fails closed with the dedicated coarse reason' (
        (-not $leakVerdict.ok) -and $leakVerdict.reason -eq 'PM2_ENV_METASHEET_ADMIN_TOKEN_NONEMPTY'
      )
      $env:T9_PS51_JLIST = '[{"name":"metasheet-backend","pm2_env":{"status":"online","restart_time":3,"pm_uptime":1000,"env":{"Path":"first","PATH":"second"}}}]'
      $cleanSample = Get-Pm2Sample
      $cleanVerdict = Test-Pm2TokenHygieneSample $cleanSample
      Check 'ps51 hygiene: clean env parses and passes under 5.1' (
        $null -ne $cleanSample -and $cleanSample.adminTokenNonEmpty -eq $false -and $cleanVerdict.ok
      )
      Check 'ps51 hygiene: stale projection without booleans fails closed' (
        (Test-Pm2TokenHygieneSample ([pscustomobject]@{ state = 'online'; restartTime = 3; uptime = 1000 })).reason -eq 'hygiene_fields_missing'
      )
    } finally {
      Remove-Item Env:T9_PS51_JLIST -ErrorAction SilentlyContinue
      Remove-Item Function:script:pm2 -ErrorAction SilentlyContinue
    }
  } finally {
    Remove-Item -Recurse -Force $hygieneDir -ErrorAction SilentlyContinue
  }
}

if ($fail -gt 0) {
  Write-Host "FAILED: $fail check(s); $pass passed"
  exit 1
}

Write-Host "ALL POWERSHELL 5.1 CHECKS PASS ($pass checks)"
exit 0
