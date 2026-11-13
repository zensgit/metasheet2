[CmdletBinding()]
param([switch]$SelfTest)
$ErrorActionPreference = 'Stop'
try {
  $node = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
  $helper = Join-Path $PSScriptRoot 'multitable-onprem-network-selfcheck.mjs'
  if ($SelfTest) {
    & $node.Source $helper --selftest 2>$null
  } else {
    & $node.Source $helper 2>$null
  }
  exit $LASTEXITCODE
} catch {
  $time = [DateTime]::UtcNow.ToString('o')
  Write-Output "FAIL runtime httpStatus=0 time=$time elapsedMs=0 requestId=unavailable"
  Write-Output 'HINT Verify the local Node runtime with an authorized operator; do not change security policy.'
  Write-Output 'SUMMARY PASS=0 FAIL=1 SKIP=0'
  exit 1
}
