#requires -Version 5.1
$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot '..' 'stock-preparation-rca-window.ps1'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
  $scriptPath,
  [ref]$tokens,
  [ref]$errors
)
$source = Get-Content -LiteralPath $scriptPath -Raw
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$workflowPath = Join-Path $repoRoot '.github/workflows/plugin-tests.yml'
$workflowSource = Get-Content -LiteralPath $workflowPath -Raw
$pass = 0
$fail = 0

function Check {
  param([string]$Name, [bool]$Ok)
  if ($Ok) { $script:pass++; Write-Host "  PASS  $Name" }
  else { $script:fail++; Write-Host "  FAIL  $Name" }
}

function Find-Function {
  param([string]$Name)
  return @($ast.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq $Name
  }, $true))
}

Check 'runner parses under the PowerShell 5.1 grammar' ($errors.Count -eq 0)
$windowsJob = [regex]::Match(
  $workflowSource,
  '(?ms)^  stock-prep-powershell51:\r?\n(?<body>.*?)(?=^  [a-zA-Z0-9_-]+:|\z)'
)
Check 'real Windows PowerShell 5.1 job runs the full RC-A behavior suite' (
  $windowsJob.Success -and
  $windowsJob.Groups['body'].Value -match 'shell:\s+powershell' -and
  $windowsJob.Groups['body'].Value -match '\$powershell51' -and
  $windowsJob.Groups['body'].Value -match 'stock-preparation-rca-window\.ps51\.tests\.ps1' -and
  $windowsJob.Groups['body'].Value -match 'stock-preparation-rca-window\.behavior\.tests\.ps1'
)
foreach ($name in @(
  'Prepare-FrozenHelpers', 'Invoke-Pm2NativeCapture', 'Invoke-Pm2Projection', 'Get-Pm2Sample',
  'Suspend-UnsafePm2Environment', 'Restore-Pm2Environment', 'Invoke-Pm2RestartStable',
  'Invoke-SmokeCapture',
  'Apply-SmokeVerdict', 'Invoke-PhysicalReadback', 'Invoke-TokenLogout', 'Invoke-RcaWindow',
  'Format-RcaResultBlock'
)) {
  Check "required function exists: $name" ((Find-Function $name).Count -eq 1)
}

$smokeFunction = (Find-Function 'Invoke-SmokeCapture')[0]
$smokeNodeCalls = @($smokeFunction.Body.FindAll({
  param($node)
  $node -is [System.Management.Automation.Language.CommandAst] -and
  $node.GetCommandName() -eq 'node'
}, $true))
Check 'smoke capture has exactly one native node invocation site' ($smokeNodeCalls.Count -eq 1)
Check 'smoke invocation carries the mandatory approved config reference' (
  $smokeFunction.Extent.Text -match [regex]::Escape("'--approved-source-config-id'")
)
Check 'smoke invocation carries the fixed 15000ms timeout' (
  $smokeFunction.Extent.Text -match [regex]::Escape("'--timeout-ms', '15000'")
)
Check 'smoke token environment is cleared in the capture finally path' (
  $smokeFunction.Extent.Text -match 'finally\s*\{[\s\S]*Remove-TokenCarriers'
)
Check 'at-most-once smoke guard precedes the invocation counter increment' (
  $smokeFunction.Extent.Text.IndexOf('SmokeInvocationCount -ne 0') -ge 0 -and
  $smokeFunction.Extent.Text.IndexOf('SmokeInvocationCount -ne 0') -lt
    $smokeFunction.Extent.Text.IndexOf('SmokeInvocationCount++')
)

$windowFunction = (Find-Function 'Invoke-RcaWindow')[0]
$windowText = $windowFunction.Extent.Text
Check 'window has an unconditional finally block' ($windowText -match 'finally\s*\{')
Check 'finally restores the feature flag to literal false before PM2 restart verification' (
  $windowText -match "finally\s*\{[\s\S]*MULTITABLE_STOCK_PREP_PLM_AUTOPERSIST_ENABLED\s*=\s*'false'[\s\S]*Invoke-Pm2RestartStable\s+-ExpectedFlagTrue\s+\`$false"
)
Check 'OFF restart attempt depends only on entering the window, never on helper availability' (
  $windowText -match 'if\s*\(\$restoreRequired\)\s*\{' -and
  $windowText -notmatch 'if\s*\(\$restoreRequired\s+-and\s+\$script:PreparedPm2Helper\)'
)
Check 'overall PASS requires every restoration and hygiene result' (
  $windowText -match "flagRestoredOff -eq 'PASS'" -and
  $windowText -match "postRestorePm2StableOnline -eq 'PASS'" -and
  $windowText -match "postRestoreHealth -eq 'PASS'" -and
  $windowText -match "postRestoreCredentialHygiene -eq 'PASS'" -and
  $windowText -match "tokenRevoked -eq 'PASS'"
)
Check 'physical readback is downstream of a successful smoke verdict' (
  $windowText.IndexOf('if (-not $smokeOk)') -ge 0 -and
  $windowText.IndexOf('Invoke-PhysicalReadback') -ge 0 -and
  $windowText.IndexOf('if (-not $smokeOk)') -lt $windowText.IndexOf('Invoke-PhysicalReadback')
)
foreach ($name in @('Invoke-Pm2NativeCapture', 'Invoke-Pm2Projection')) {
  $nativeText = (Find-Function $name)[0].Extent.Text
  Check "$name scopes native stderr promotion and restores the caller policy" (
    $nativeText -match "ErrorActionPreference\s*=\s*'Continue'" -and
    $nativeText -match 'finally\s*\{[\s\S]*ErrorActionPreference\s*=\s*\$oldPreference'
  )
}
Check 'PM2 native boundary suspends and restores non-allowlisted shell variables' (
  (Find-Function 'Invoke-Pm2NativeCapture')[0].Extent.Text -match 'Suspend-UnsafePm2Environment' -and
  (Find-Function 'Invoke-Pm2NativeCapture')[0].Extent.Text -match 'finally\s*\{[\s\S]*Restore-Pm2Environment'
)
Check 'cleanup isolates PM2 sampling, health, token revocation, helper cleanup, and lock release' (
  [regex]::Matches($windowText, '(?s)try\s*\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}\s*catch').Count -ge 7 -and
  $windowText -match '(?s)try\s*\{\s*Remove-PreparedHelpers\s*\}\s*catch' -and
  $windowText -match '(?s)try\s*\{\s*Exit-RcaWindowLock\s*\}\s*catch'
)
Check 'runner never persists the temporary flag with pm2 save' ($source -notmatch '(?im)\bpm2\s+save\b')
Check 'runner never invokes an external-write route' (
  $source -notmatch 'external-write|k3Save|submit|plmExternalWrite'
)
Check 'only the frozen internal read endpoints are used for physical readback' (
  $source -match '/stock-preparation/projects' -and
  $source -match '/stock-preparation/snapshot-batches' -and
  $source -notmatch '/records'
)
Check 'authenticated PowerShell requests refuse redirects' (
  (Find-Function 'Invoke-AuthenticatedJsonGet')[0].Extent.Text -match 'MaximumRedirection\s+0' -and
  (Find-Function 'Invoke-TokenLogout')[0].Extent.Text -match 'MaximumRedirection\s+0'
)
Check 'all three companion helper digests are full lowercase SHA-256 pins' (
  ([regex]::Matches($source, "'[0-9a-f]{64}'").Count -eq 3)
)
Check 'lock release keeps the stable lock inode instead of deleting it' (
  (Find-Function 'Exit-RcaWindowLock')[0].Extent.Text -notmatch 'Remove-Item'
)

. $scriptPath
$result = New-RcaResult
Check 'result block has the same exact keys as the closed vocabulary' (
  @($result.Keys).Count -eq @($script:ResultVocabulary.Keys).Count -and
  (@($result.Keys) -join '|') -eq (@($script:ResultVocabulary.Keys) -join '|')
)
Check 'default result is vocabulary-valid and values-free' (
  (Test-RcaResultVocabulary $result) -and
  (Format-RcaResultBlock $result) -notmatch 'MAT-001|customer-alpha|http://|[\\/](Users|home)[\\/]'
)

Write-Host "stock-preparation RC-A window contract: $pass passed, $fail failed"
if ($fail -gt 0) { exit 1 }
