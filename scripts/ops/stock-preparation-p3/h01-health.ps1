# GET /api/health using the QA bundle's shared HTTP helper. No token is used.
# P3Commit comes from verified, in-archive provenance at the cut.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-f]{40}$')]
  [string]$P3Commit
)

$ErrorActionPreference = 'Stop'
$r85 = '220bd80ab62fc7e6b3b40b7d4263a712d9a09405'
if ($P3Commit -eq $r85) {
  'HEALTH_RESULT file=h01-health.ps1 status=incomplete reason=ambiguous_build'
  exit 2
}

try {
  . (Join-Path $PSScriptRoot '_http.ps1')
  $why = Initialize-Http -NoToken
  if ($why) {
    'HEALTH_RESULT file=h01-health.ps1 status=incomplete reason=' + $why
    exit 2
  }
  $response = Invoke-Http 'GET' '/api/health' -Anonymous
  if ($response.NoAnswer) {
    'HEALTH_RESULT file=h01-health.ps1 status=incomplete reason=' + $response.NoAnswer
    exit 3
  }

  $commit = ''
  if ($null -ne $response.Json) {
    $buildProperty = $response.Json.PSObject.Properties['build']
    if ($null -ne $buildProperty -and $null -ne $buildProperty.Value) {
      $commitProperty = $buildProperty.Value.PSObject.Properties['commit']
      if ($null -ne $commitProperty) { $commit = [string]$commitProperty.Value }
    }
  }
  $build = if ($commit -ceq $r85) { 'R85' }
    elseif ($commit -ceq $P3Commit.ToLowerInvariant()) { 'P3' }
    elseif ([string]::IsNullOrEmpty($commit)) { 'absent' }
    else { 'other' }
  'HEALTH status={0} build={1}' -f $response.Status, $build
  'HEALTH_RESULT file=h01-health.ps1 status=complete'
} catch {
  'HEALTH_RESULT file=h01-health.ps1 status=incomplete reason=script_error'
  exit 3
}
