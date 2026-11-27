# GET /api/health, either label-only or bound to the actual local listener.
# P3Commit comes from verified, in-archive provenance at the cut.
[CmdletBinding(DefaultParameterSetName = 'Label')]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-f]{40}$')]
  [string]$P3Commit,
  [Parameter(Mandatory = $true, ParameterSetName = 'Signoff')][string]$InstallRoot,
  [Parameter(Mandatory = $true, ParameterSetName = 'Signoff')][string]$OverlayCompletedUtc,
  [Parameter(Mandatory = $true, ParameterSetName = 'Signoff')]
  [ValidateSet('P3', 'R84', 'R85')][string]$ExpectedBuild
)

$ErrorActionPreference = 'Stop'
$r85 = '220bd80ab62fc7e6b3b40b7d4263a712d9a09405'
$r84 = 'beed2a1e1cd239975d695ce6ce4d7264e38c3a1e'
if ($P3Commit -in @($r85, $r84)) {
  'HEALTH_RESULT file=h01-health.ps1 status=incomplete reason=ambiguous_build'
  exit 2
}

function Get-LoopbackAddress([string]$Address) {
  $ip = [Net.IPAddress]::None
  if (-not [Net.IPAddress]::TryParse($Address, [ref]$ip)) { return $null }
  if ($ip.IsIPv4MappedToIPv6) { $ip = $ip.MapToIPv4() }
  if (-not [Net.IPAddress]::IsLoopback($ip)) { return $null }
  return $ip
}

function Wait-HealthPeer([Net.IPEndPoint]$Listener, [Net.IPEndPoint]$Local) {
  $script:healthFailure = 'peer_lookup_timeout'
  $elapsed = [Diagnostics.Stopwatch]::StartNew()
  for ($attempt = 0; $attempt -lt 12 -and $elapsed.ElapsedMilliseconds -lt 3000; $attempt++) {
    try {
      $peers = @(Get-NetTCPConnection -LocalPort $Listener.Port -RemotePort $Local.Port -State Established -ErrorAction Stop |
        Where-Object { (Get-LoopbackAddress $_.LocalAddress) -eq $Listener.Address -and
          (Get-LoopbackAddress $_.RemoteAddress) -eq $Local.Address })
    } catch {
      if ($_.CategoryInfo.Category -ne 'ObjectNotFound') {
        $script:healthFailure = 'peer_lookup_failed'
        throw
      }
      $peers = @()
    }
    if ($peers.Count -gt 1 -or ($peers.Count -eq 1 -and $peers[0].OwningProcess -le 0)) {
      $script:healthFailure = 'peer_owner_unconfirmed'
      throw 'ambiguous health peer'
    }
    if ($peers.Count -eq 1 -and $elapsed.ElapsedMilliseconds -lt 3000) {
      $script:healthFailure = 'script_error'
      return [int]$peers[0].OwningProcess
    }
    if ($attempt -lt 11 -and $elapsed.ElapsedMilliseconds -lt 3000) { Start-Sleep -Milliseconds 100 }
  }
  throw 'health peer not found before deadline'
}

function Invoke-BoundHealth {
  # Open a direct local connection and ask the OS which process owns its server
  # endpoint before sending any HTTP bytes. Read the response from that socket.
  $uri = [Uri]$env:MS_API
  $ip = Get-LoopbackAddress $uri.DnsSafeHost
  if ($null -eq $ip -or $uri.Scheme -cne 'http' -or $uri.AbsolutePath -ne '/' -or
      $uri.UserInfo -or $uri.Query -or $uri.Fragment) { throw 'direct loopback required' }
  # Resolve the system cmdlet before starting the peer lookup budget.
  $null = Get-Command Get-NetTCPConnection -ErrorAction Stop

  $client = [Net.Sockets.TcpClient]::new($ip.AddressFamily)
  $bytes = [IO.MemoryStream]::new()
  try {
    $connect = $client.ConnectAsync($ip, $uri.Port)
    if (-not $connect.Wait(8000)) { throw 'connect timeout' }
    $peerId = Wait-HealthPeer $client.Client.RemoteEndPoint $client.Client.LocalEndPoint
    $peerStarted = (Get-Process -Id $peerId).StartTime.ToUniversalTime()
    $stream = $client.GetStream()
    $stream.ReadTimeout = 8000
    $stream.WriteTimeout = 8000
    $request = [Text.Encoding]::ASCII.GetBytes("GET /api/health HTTP/1.1`r`nHost: $($uri.Authority)`r`nConnection: close`r`nAccept: application/json`r`n`r`n")
    $stream.Write($request, 0, $request.Length)
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $buffer = New-Object byte[] 4096
    while (($count = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
      if ($bytes.Length + $count -gt 1MB -or $timer.Elapsed.TotalSeconds -gt 8) { throw 'invalid health response size or time' }
      $bytes.Write($buffer, 0, $count)
    }
    $raw = [Text.Encoding]::UTF8.GetString($bytes.ToArray())
    $parts = $raw -split "`r`n`r`n", 2
    if ($parts.Count -ne 2 -or $parts[0] -cnotmatch '^HTTP/1\.[01] ([1-5][0-9]{2}) ') { throw 'invalid health response' }
    $status = [int]$Matches[1]
    $length = [regex]::Matches($parts[0], '(?im)^Content-Length:[ \t]*([0-9]{1,7})\r?$')
    if ($length.Count -ne 1 -or [int]$length[0].Groups[1].Value -ne [Text.Encoding]::UTF8.GetByteCount($parts[1])) {
      throw 'invalid health body length'
    }
    $json = ConvertFrom-Json -InputObject $parts[1]
    return @{ Status = $status; Json = $json; PeerId = $peerId; PeerStarted = $peerStarted }
  } finally {
    $bytes.Dispose()
    $client.Dispose()
  }
}

$healthFailure = 'script_error'
try {
  if ($PSCmdlet.ParameterSetName -eq 'Signoff') {
    $response = Invoke-BoundHealth
  } else {
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
    elseif ($commit -ceq $r84) { 'R84' }
    elseif ($commit -ceq $P3Commit.ToLowerInvariant()) { 'P3' }
    elseif ([string]::IsNullOrEmpty($commit)) { 'absent' }
    else { 'other' }
  'HEALTH status={0} build={1}' -f $response.Status, $build
  if ($PSCmdlet.ParameterSetName -eq 'Signoff') {
    if ($response.Status -ne 200 -or $build -ne $ExpectedBuild) {
      'HEALTH_RESULT file=h01-health.ps1 status=incomplete reason=unexpected_build_or_status'
      exit 3
    }
    $probe = Join-Path $PSScriptRoot '..\ps\03-live-env-check.ps1'
    $proof = @(& $probe -InstallRoot $InstallRoot -StartedAfterUtc $OverlayCompletedUtc -HealthPeerPid $response.PeerId)
    if ($LASTEXITCODE -ne 0 -or $proof -cnotcontains 'LIVEENV_BACKEND generation=fresh' -or
        (Get-Process -Id $response.PeerId).StartTime.ToUniversalTime() -ne $response.PeerStarted) {
      'HEALTH_RESULT file=h01-health.ps1 status=incomplete reason=backend_not_bound_or_fresh'
      exit 3
    }
    'HEALTH_RUNTIME peer=verified generation=post_overlay'
  } else {
    'HEALTH_RUNTIME peer=unchecked generation=unknown'
  }
  'HEALTH_RESULT file=h01-health.ps1 status=complete'
} catch {
  'HEALTH_RESULT file=h01-health.ps1 status=incomplete reason=' + $healthFailure
  exit 3
}
