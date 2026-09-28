#requires -Version 5.1
# Runs scripts/ops/multitable-onprem-package-upgrade-inplace.test.mjs (node:test) with
# the PowerShell that runs THIS file as the shell under test
# (UPGRADE_INPLACE_TEST_SHELL), so the same suite covers Windows PowerShell 5.1 and
# pwsh 7 on Windows. Part of that suite only means something on Windows: the real
# \\.\pipe\ enumeration behind the in-place upgrade's pm2 daemon check, and Windows
# PowerShell 5.1's native-stderr semantics (the R59 incident: pm2's "not found" on
# stderr became a terminating NativeCommandError). The ubuntu `test` job runs the
# suite under pwsh 7 on Linux and can reach none of that.
#
# CI: the stock-prep-powershell51 job (windows-latest) runs
# scripts/ops/__tests__/multitable-onprem-s6a-artifact-root-acl.tests.ps1 under 5.1
# and under pwsh 7, and that file runs this one with its own host shell. The hops are
# pinned by the "CI wiring (Windows lanes)" test in the suite itself.
#
# Off Windows this is a no-op (exit 0): the ubuntu job already runs the suite.
# ASCII only: Windows PowerShell 5.1 reads a BOM-less file in the ANSI code page.
$ErrorActionPreference = 'Stop'

$isWindowsHost = ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT)
if (-not $isWindowsHost) {
  Write-Host 'SKIP multitable-onprem-package-upgrade-inplace Windows-shell lane (not Windows)'
  exit 0
}

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\..')).ProviderPath
$testFile = Join-Path $repoRoot 'scripts\ops\multitable-onprem-package-upgrade-inplace.test.mjs'
$node = (Get-Command -Name 'node' -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source

# The shell under test is this process's own executable; the suite checks that every
# harness really ran that edition ("shell under test" test).
$env:UPGRADE_INPLACE_TEST_SHELL = (Get-Process -Id $PID).Path
$env:UPGRADE_INPLACE_TEST_EXPECT_EDITION = $PSVersionTable.PSEdition
# The suite spawns the shell with -File and without -ExecutionPolicy; an inherited
# preference keeps a Restricted/RemoteSigned machine policy out of the result.
$env:PSExecutionPolicyPreference = 'Bypass'

Write-Host ("== multitable-onprem-package-upgrade-inplace suite under {0} {1} ({2})" -f $PSVersionTable.PSEdition, $PSVersionTable.PSVersion, $env:UPGRADE_INPLACE_TEST_SHELL)

Push-Location -LiteralPath $repoRoot
$ErrorActionPreference = 'Continue'
try {
  $global:LASTEXITCODE = -1
  $output = & $node --test $testFile 2>&1
  $nodeExit = $LASTEXITCODE
} finally {
  $ErrorActionPreference = 'Stop'
  Pop-Location
}

$lines = @($output | ForEach-Object { [string]$_ })
foreach ($line in $lines) {
  Write-Host $line
}

function Get-TapCount {
  param([string[]]$Lines, [string]$Name)
  foreach ($line in $Lines) {
    if ($line -match ('^# ' + $Name + ' (\d+)\s*$')) {
      return [int]$Matches[1]
    }
  }
  return -1
}

$tests = Get-TapCount -Lines $lines -Name 'tests'
$pass = Get-TapCount -Lines $lines -Name 'pass'
$fail = Get-TapCount -Lines $lines -Name 'fail'
$skipped = Get-TapCount -Lines $lines -Name 'skipped'
$todo = Get-TapCount -Lines $lines -Name 'todo'
$cancelled = Get-TapCount -Lines $lines -Name 'cancelled'

# The checks that exist for this lane must have run AND passed here, not merely the
# suite as a whole: a green exit with them missing would be a dead lane.
$requiredOk = @(
  '^ok \d+ - shell under test:',
  '^ok \d+ - Test-Pm2DaemonPipePresent / Wait-Pm2DaemonPipeClosed:',
  '^ok \d+ - end-to-end \(acid fixture, R59 replay\):'
)
$missing = @()
foreach ($pattern in $requiredOk) {
  if (-not ($lines | Where-Object { $_ -match $pattern })) {
    $missing += $pattern
  }
}

$problems = @()
if ($nodeExit -ne 0) { $problems += "node --test exit=$nodeExit" }
if ($tests -le 0) { $problems += "no test count reported (tests=$tests)" }
if ($pass -ne $tests) { $problems += "pass=$pass of tests=$tests" }
if ($fail -ne 0) { $problems += "fail=$fail" }
if ($skipped -ne 0) { $problems += "skipped=$skipped" }
if ($todo -ne 0) { $problems += "todo=$todo" }
if ($cancelled -ne 0) { $problems += "cancelled=$cancelled" }
foreach ($pattern in $missing) { $problems += "required test not ok: $pattern" }

if ($problems.Count -gt 0) {
  Write-Host ("FAILED multitable-onprem-package-upgrade-inplace suite under {0} {1}: {2}" -f $PSVersionTable.PSEdition, $PSVersionTable.PSVersion, ($problems -join '; '))
  exit 1
}
Write-Host ("PASSED multitable-onprem-package-upgrade-inplace suite under {0} {1}: {2}/{3} tests" -f $PSVersionTable.PSEdition, $PSVersionTable.PSVersion, $pass, $tests)
exit 0
