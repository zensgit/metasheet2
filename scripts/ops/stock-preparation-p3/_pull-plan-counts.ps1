# Stable allowlist shared by the synchronous and background pull previews.
function Get-PullPlanCountsLine($Data, [int]$Ordinal) {
  if ($null -eq $Data -or $null -eq $Data.counts) { return $null }
  $counts = $Data.counts
  $parts = @()
  foreach ($key in @('add', 'update', 'skip', 'inactive', 'manual_confirm')) {
    $value = $counts.$key
    if (($value -isnot [int] -and $value -isnot [long]) -or $value -lt 0) { return $null }
    $parts += ('{0}={1}' -f $key, $value)
  }
  'PULLDRY_COUNTS project={0} {1}' -f $Ordinal, ($parts -join ' ')
}
