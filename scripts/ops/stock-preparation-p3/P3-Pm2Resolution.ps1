# Shared by the P3 QA probe and its signoff restart. Match the Windows release
# startup helper's local-first lookup and PATH prepends (including R84/R85).
function Resolve-P3Pm2([string]$InstallRoot) {
  $toolPath = New-Object System.Collections.Generic.List[string]
  foreach ($entry in ($env:PATH -split ';')) {
    if (-not [string]::IsNullOrWhiteSpace($entry)) { $toolPath.Add($entry) }
  }

  $candidates = @()
  foreach ($base in @($env:ProgramFiles, [Environment]::GetEnvironmentVariable('ProgramFiles(x86)'),
      'C:\Program Files', 'C:\Program Files (x86)')) {
    if (-not [string]::IsNullOrWhiteSpace($base)) { $candidates += Join-Path $base 'nodejs' }
  }
  $npmBases = @($env:APPDATA, 'C:\Users\Administrator\AppData\Roaming')
  if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) { $npmBases += Join-Path $env:USERPROFILE 'AppData\Roaming' }
  foreach ($base in $npmBases) {
    if (-not [string]::IsNullOrWhiteSpace($base)) { $candidates += Join-Path $base 'npm' }
  }
  $systemRoot = if ([string]::IsNullOrWhiteSpace($env:SystemRoot)) { 'C:\Windows' } else { $env:SystemRoot }
  $candidates += @((Join-Path $systemRoot 'System32'), $systemRoot)

  foreach ($dir in $candidates | Select-Object -Unique) {
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { continue }
    $alreadyPresent = $false
    foreach ($entry in $toolPath) {
      if ($entry.TrimEnd('\') -ieq $dir.TrimEnd('\')) { $alreadyPresent = $true; break }
    }
    if (-not $alreadyPresent) { $toolPath.Insert(0, $dir) }
  }

  $effectivePath = $toolPath -join ';'
  $local = Join-Path $InstallRoot 'node_modules\.bin\pm2.cmd'
  if (Test-Path -LiteralPath $local -PathType Leaf) {
    return @{ Kind = 'local'; Command = (Get-Item -LiteralPath $local).FullName; ToolPath = $effectivePath }
  }
  foreach ($entry in $toolPath) {
    $dir = $entry.Trim().Trim('"')
    if (-not [IO.Path]::IsPathRooted($dir)) { continue }
    $command = Join-Path $dir 'pm2.cmd'
    if (Test-Path -LiteralPath $command -PathType Leaf) {
      return @{ Kind = 'path'; Command = (Get-Item -LiteralPath $command).FullName; ToolPath = $effectivePath }
    }
  }
  return @{ Kind = 'none'; Command = $null; ToolPath = $effectivePath }
}
