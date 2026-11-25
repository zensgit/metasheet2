# onprem-live-env-lib.ps1
# Shared, read-only hosting decision for 02-pm2-owner-check.ps1 and 03-live-env-check.ps1.
# Windows PowerShell 5.1. Dot-sourced. Running this file by itself does nothing.
#
# A pm2 CLI command that finds nobody listening starts a new empty God daemon.
# Resolve-LiveEnvHosting therefore sets RunJlist only when one of these is already true:
#   god          <PM2_HOME>\pm2.pid names a live node.exe owned by this account, and
#                \\.\pipe\rpc.sock is already present (the God is the listener)
#   pm2-runtime  there is no such pid, and exactly one scheduled task (default
#                MetaSheet-PM2) is owned by this account and Running or Ready, and
#                exactly one node.exe owned by this account has a pm2-runtime command
#                line, and the live metasheet-backend pid's parent is that process, and
#                the pipe is already present, and no other node.exe has pm2\lib\Daemon.js
#                on its command line, and PM2_HOME already contains the directories and
#                module_conf.json a pm2 client would otherwise create
# Anything else leaves RunJlist false. Callers must not start pm2 in that case.

function New-LiveEnvDecision {
  param(
    [string]$Hosting = 'none',
    [bool]$RunJlist = $false,
    [bool]$Owned = $false,
    [string]$Reason = '',
    [string]$OwnerStatus = 'incomplete',
    [string]$OwnerReason = ''
  )
  return [pscustomobject]@{
    Hosting     = $Hosting
    RunJlist    = $RunJlist
    Owned       = $Owned
    Reason      = $Reason
    OwnerStatus = $OwnerStatus
    OwnerReason = $OwnerReason
  }
}

function New-LiveEnvStop {
  param(
    [string]$Reason,
    [string]$OwnerReason = '',
    [string]$OwnerStatus = 'incomplete'
  )
  if ([string]::IsNullOrEmpty($OwnerReason)) { $OwnerReason = $Reason }
  return New-LiveEnvDecision -Reason $Reason -OwnerStatus $OwnerStatus -OwnerReason $OwnerReason
}

function New-LiveEnvNotOurs {
  param([string]$Reason = 'daemon_not_owned')
  # The check could be read, and this account is not the owner. 02 keeps its
  # historical "status=complete owned=false" for that case. 03 still refuses jlist.
  return New-LiveEnvDecision -Reason $Reason -Owned $false -RunJlist $false -OwnerStatus 'complete' -OwnerReason ''
}

function Resolve-LiveEnvHosting {
  param($Facts)

  $pipe = [string]$Facts.Pipe
  $daemonAlive = [bool]$Facts.DaemonAlive
  $daemonOwner = [string]$Facts.DaemonOwner
  if ([string]::IsNullOrEmpty($daemonOwner)) { $daemonOwner = 'false' }

  if ($daemonAlive) {
    if ($daemonOwner -eq 'unknown') { return New-LiveEnvStop -Reason 'owner_unreadable' }
    if ($daemonOwner -ne 'true') { return New-LiveEnvNotOurs -Reason 'daemon_not_owned' }
    if ([string]$Facts.StrayGod -eq 'unknown') { return New-LiveEnvStop -Reason 'owner_unreadable' }
    if ([string]$Facts.StrayGod -eq 'true') { return New-LiveEnvStop -Reason 'stray_daemon' }
    if ($pipe -eq 'unknown') { return New-LiveEnvStop -Reason 'pipe_unknown' }
    if ($pipe -ne 'present') { return New-LiveEnvStop -Reason 'no_daemon' }
    $owned = [bool]$Facts.AppAlive -and ([string]$Facts.AppOwner -eq 'true')
    if ([string]$Facts.AppOwner -eq 'unknown') {
      return New-LiveEnvDecision -Hosting 'god' -RunJlist $true -Owned $false -OwnerStatus 'incomplete' -OwnerReason 'owner_unreadable'
    }
    return New-LiveEnvDecision -Hosting 'god' -RunJlist $true -Owned $owned -OwnerStatus 'complete'
  }

  if ($pipe -eq 'unknown') { return New-LiveEnvStop -Reason 'pipe_unknown' }
  if ($pipe -ne 'present') {
    $queryOk = [string]$Facts.ProcessQuery -eq 'ok'
    if (-not $queryOk) { return New-LiveEnvStop -Reason 'no_daemon' -OwnerReason 'owner_unreadable' }
    $nothing = (-not [bool]$Facts.AppAlive) -and ([int]$Facts.RuntimeProcessCount -eq 0) -and ([string]$Facts.RuntimeTask -eq 'absent') -and ([string]$Facts.StrayGod -eq 'false') -and ([string]$Facts.OtherUserPm2 -ne 'true') -and (-not [bool]$Facts.DaemonPidFile)
    if ($nothing) { return New-LiveEnvStop -Reason 'no_daemon' -OwnerReason 'no_pm2_process' }
    return New-LiveEnvStop -Reason 'no_daemon'
  }

  if ([string]$Facts.ProcessQuery -ne 'ok') { return New-LiveEnvStop -Reason 'owner_unreadable' }
  if ([string]$Facts.StrayGod -eq 'unknown') { return New-LiveEnvStop -Reason 'owner_unreadable' }
  if ([string]$Facts.StrayGod -eq 'true') { return New-LiveEnvStop -Reason 'stray_daemon' }

  $task = [string]$Facts.RuntimeTask
  if ($task -eq 'unknown') { return New-LiveEnvStop -Reason 'owner_unreadable' }
  if ($task -eq 'ambiguous') { return New-LiveEnvStop -Reason 'host_ambiguous' }
  if ($task -ne 'present') { return New-LiveEnvStop -Reason 'no_daemon' }
  if ([string]$Facts.RuntimeTaskOwner -eq 'unknown') { return New-LiveEnvStop -Reason 'owner_unreadable' }
  if ([string]$Facts.RuntimeTaskOwner -ne 'true') { return New-LiveEnvNotOurs -Reason 'daemon_not_owned' }

  $state = [string]$Facts.RuntimeTaskState
  if ($state -ne 'running' -and $state -ne 'ready') { return New-LiveEnvStop -Reason 'task_not_running' }
  if ([string]$Facts.RuntimeProcessOwner -eq 'unknown') { return New-LiveEnvStop -Reason 'owner_unreadable' }
  if ([int]$Facts.RuntimeProcessCount -gt 1) { return New-LiveEnvStop -Reason 'host_ambiguous' }
  if ([int]$Facts.RuntimeProcessCount -ne 1 -or [string]$Facts.RuntimeProcessOwner -ne 'true') {
    return New-LiveEnvStop -Reason 'no_daemon'
  }
  if ([string]$Facts.AppOwner -eq 'unknown') { return New-LiveEnvStop -Reason 'owner_unreadable' }
  if ((-not [bool]$Facts.AppAlive) -or ([string]$Facts.AppOwner -ne 'true') -or (-not [bool]$Facts.AppParentIsRuntime)) {
    return New-LiveEnvStop -Reason 'app_not_under_runtime'
  }
  if ((-not [bool]$Facts.HomeExists) -or (-not [bool]$Facts.HomeInitialized)) {
    return New-LiveEnvStop -Reason 'pm2_home_not_initialized'
  }
  return New-LiveEnvDecision -Hosting 'pm2-runtime' -RunJlist $true -Owned $true -OwnerStatus 'complete'
}

function Convert-LiveEnvAccountWord {
  param([string]$Candidate, [string]$Me)
  if ([string]::IsNullOrWhiteSpace($Candidate) -or [string]::IsNullOrWhiteSpace($Me)) { return 'unknown' }
  if ([string]::Equals($Candidate, $Me, [System.StringComparison]::OrdinalIgnoreCase)) { return 'true' }
  $meUser = $Me
  $slash = $Me.LastIndexOf('\')
  if ($slash -ge 0 -and $slash -lt ($Me.Length - 1)) { $meUser = $Me.Substring($slash + 1) }
  if (($Candidate.IndexOf('\') -lt 0) -and [string]::Equals($Candidate, $meUser, [System.StringComparison]::OrdinalIgnoreCase)) { return 'true' }
  return 'false'
}

function Test-LiveEnvGodCommandLine {
  param([string]$CommandLine)
  if ([string]::IsNullOrEmpty($CommandLine)) { return $false }
  return $CommandLine -match 'pm2[\\/]+lib[\\/]+Daemon\.js'
}

function Test-LiveEnvRuntimeCommandLine {
  param([string]$CommandLine)
  if ([string]::IsNullOrEmpty($CommandLine)) { return $false }
  if (Test-LiveEnvGodCommandLine -CommandLine $CommandLine) { return $false }
  if ($CommandLine -match 'pm2-runtime') { return $true }
  if ($CommandLine -match 'Runtime4Docker') { return $true }
  if ($CommandLine -match 'binaries[\\/]+Runtime(4Docker)?\.js') { return $true }
  return $false
}

function Get-LiveEnvCurrentUser {
  if ($null -ne $script:LiveEnvCiProbe) {
    $fromProbe = [string]$script:LiveEnvCiProbe.currentUser
    if (-not [string]::IsNullOrWhiteSpace($fromProbe)) { return $fromProbe }
  }
  try {
    $name = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    if (-not [string]::IsNullOrWhiteSpace([string]$name)) { return [string]$name }
  } catch { }
  return ''
}

function Get-LiveEnvPipeState {
  if ($null -ne $script:LiveEnvCiProbe) {
    $probePipe = [string]$script:LiveEnvCiProbe.pipe
    if ($probePipe -eq 'present' -or $probePipe -eq 'absent' -or $probePipe -eq 'unknown') { return $probePipe }
    return 'unknown'
  }
  if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) { return 'absent' }
  try {
    $suffix = '\rpc.sock'
    foreach ($pipePath in [System.IO.Directory]::GetFiles('\\.\pipe\', 'rpc.sock')) {
      if ($pipePath.EndsWith($suffix, [System.StringComparison]::OrdinalIgnoreCase)) { return 'present' }
    }
    return 'absent'
  } catch {
    return 'unknown'
  }
}

function Get-LiveEnvProbeList {
  param([string]$PropertyName)
  if ($null -eq $script:LiveEnvCiProbe) { return @() }
  $prop = $script:LiveEnvCiProbe.PSObject.Properties[$PropertyName]
  if ($null -eq $prop -or $null -eq $prop.Value) { return @() }
  return @($prop.Value)
}

function Get-LiveEnvTaskFacts {
  param([string]$TaskName, [string]$Me)
  $absent = @{ Task = 'absent'; State = 'none'; Owner = 'none' }
  if ($null -ne $script:LiveEnvCiProbe) {
    $hits = @(Get-LiveEnvProbeList -PropertyName 'tasks' | Where-Object { $null -ne $_ -and [string]$_.taskName -eq $TaskName })
    if ($hits.Count -gt 1) { return @{ Task = 'ambiguous'; State = 'unknown'; Owner = 'unknown' } }
    if ($hits.Count -eq 0) { return $absent }
    $hit = $hits[0]
    $stateRaw = [string]$hit.state
    $stateWord = 'other'
    if ($stateRaw -eq 'Running') { $stateWord = 'running' }
    elseif ($stateRaw -eq 'Ready') { $stateWord = 'ready' }
    elseif ([string]::IsNullOrWhiteSpace($stateRaw)) { $stateWord = 'unknown' }
    $ownerWord = Convert-LiveEnvAccountWord -Candidate ([string]$hit.userId) -Me $Me
    return @{ Task = 'present'; State = $stateWord; Owner = $ownerWord }
  }
  try {
    if (-not (Get-Command -Name 'Get-ScheduledTask' -ErrorAction SilentlyContinue)) { return $absent }
    $found = @(Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Where-Object { $null -ne $_ -and [string]$_.TaskName -eq $TaskName })
  } catch {
    $message = [string]$_.Exception.Message
    if ($message -match 'No MSFT_ScheduledTask' -or $message -match 'cannot find the file specified') { return $absent }
    return @{ Task = 'unknown'; State = 'unknown'; Owner = 'unknown' }
  }
  if ($found.Count -gt 1) { return @{ Task = 'ambiguous'; State = 'unknown'; Owner = 'unknown' } }
  if ($found.Count -eq 0) { return $absent }
  $task = $found[0]
  $stateRaw = [string]$task.State
  $stateWord = 'other'
  if ($stateRaw -eq 'Running') { $stateWord = 'running' }
  elseif ($stateRaw -eq 'Ready') { $stateWord = 'ready' }
  elseif ([string]::IsNullOrWhiteSpace($stateRaw)) { $stateWord = 'unknown' }
  $userId = ''
  try { $userId = [string]$task.Principal.UserId } catch { $userId = '' }
  return @{ Task = 'present'; State = $stateWord; Owner = (Convert-LiveEnvAccountWord -Candidate $userId -Me $Me) }
}

function Resolve-LiveEnvHomePath {
  param([string]$TaskWord)
  $set = -not [string]::IsNullOrWhiteSpace($env:PM2_HOME)
  if ($set) { return @{ Path = $env:PM2_HOME; Set = $true } }
  $profileRoot = $env:USERPROFILE
  if ([string]::IsNullOrWhiteSpace($profileRoot)) {
    $sysRoot = if ([string]::IsNullOrWhiteSpace($env:SystemRoot)) { 'C:\Windows' } else { $env:SystemRoot }
    $profileRoot = Join-Path $sysRoot 'System32\config\systemprofile'
  }
  if ($TaskWord -eq 'present') {
    $runtimeHome = Join-Path $profileRoot '.pm2-runtime'
    if (Test-Path -LiteralPath $runtimeHome -PathType Container) {
      return @{ Path = $runtimeHome; Set = $false }
    }
  }
  return @{ Path = (Join-Path $profileRoot '.pm2'); Set = $false }
}

function Test-LiveEnvHomeInitialized {
  param([string]$HomePath)
  if ([string]::IsNullOrWhiteSpace($HomePath)) { return $false }
  if (-not (Test-Path -LiteralPath $HomePath -PathType Container)) { return $false }
  foreach ($rel in @('logs', 'pids', 'modules')) {
    if (-not (Test-Path -LiteralPath (Join-Path $HomePath $rel) -PathType Container)) { return $false }
  }
  return Test-Path -LiteralPath (Join-Path $HomePath 'module_conf.json') -PathType Leaf
}

function Read-LiveEnvPidNumber {
  param([string]$Path)
  try { $raw = ([string](Get-Content -LiteralPath $Path -Raw)).Trim() } catch { return 0 }
  if ($raw -match '^\d{1,10}$') { return [int]$raw }
  return 0
}

function Get-LiveEnvProcessRows {
  param([string]$Me)
  $rows = @()
  $query = 'ok'
  $raw = @()
  if ($null -ne $script:LiveEnvCiProbe) {
    $raw = @(Get-LiveEnvProbeList -PropertyName 'processes')
  } else {
    try {
      if (-not (Get-Command -Name 'Get-CimInstance' -ErrorAction SilentlyContinue)) {
        $query = 'failed'
      } else {
        $raw = @(Get-CimInstance -ClassName Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop)
      }
    } catch {
      $query = 'failed'
      $raw = @()
    }
  }
  if ($query -eq 'ok') {
    $pidTargets = @()
    foreach ($item in $raw) {
      if ($null -eq $item) { continue }
      $processId = 0
      $parentId = 0
      $name = ''
      $commandLine = ''
      $ownerText = ''
      $ownerKnown = $false
      if ($null -ne $script:LiveEnvCiProbe) {
        $processId = [int]$item.processId
        $parentId = [int]$item.parentProcessId
        $name = [string]$item.name
        $commandLine = [string]$item.commandLine
        $ownerText = [string]$item.owner
        $ownerKnown = $true
      } else {
        $processId = [int]$item.ProcessId
        $parentId = [int]$item.ParentProcessId
        $name = [string]$item.Name
        $commandLine = [string]$item.CommandLine
        try {
          $ownerResult = Invoke-CimMethod -InputObject $item -MethodName GetOwner
          if ($null -ne $ownerResult -and [int]$ownerResult.ReturnValue -eq 0 -and -not [string]::IsNullOrEmpty([string]$ownerResult.User)) {
            $ownerText = ([string]$ownerResult.Domain + '\' + [string]$ownerResult.User)
            $ownerKnown = $true
          }
        } catch {
          $ownerKnown = $false
        }
      }
      $ownerWord = 'unknown'
      if ($ownerKnown) { $ownerWord = Convert-LiveEnvAccountWord -Candidate $ownerText -Me $Me }
      $rows += [pscustomobject]@{
        Pid          = $processId
        ParentPid    = $parentId
        Name         = $name
        CommandLine  = $commandLine
        OwnerWord    = $ownerWord
        IsNode       = ($name -eq 'node.exe')
      }
      $pidTargets += $processId
    }
    # Pid-file lookups must see processes that are not named node.exe too, so a
    # recycled pid is not treated as the daemon. The CIM filter above is node-only;
    # the probe list is whatever the fixture supplied. Fetch a pid-file target
    # separately when it was not in the node list.
    $script:LiveEnvProcessIds = $pidTargets
  }
  return [pscustomobject]@{ Query = $query; Rows = $rows }
}

function Get-LiveEnvProcessByPid {
  param($Rows, [int]$ProcessId)
  if ($ProcessId -le 0) { return $null }
  foreach ($row in @($Rows)) {
    if ($null -ne $row -and [int]$row.Pid -eq $ProcessId) { return $row }
  }
  if ($null -eq $script:LiveEnvCiProbe -and $null -ne $script:LiveEnvProcessIds -and -not ($script:LiveEnvProcessIds -contains $ProcessId)) {
    try {
      $item = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId=" + $ProcessId) -ErrorAction Stop | Select-Object -First 1
      if ($null -eq $item) { return $null }
      return [pscustomobject]@{
        Pid         = [int]$item.ProcessId
        ParentPid   = [int]$item.ParentProcessId
        Name        = [string]$item.Name
        CommandLine = [string]$item.CommandLine
        OwnerWord   = 'unknown'
        IsNode      = ([string]$item.Name -eq 'node.exe')
      }
    } catch {
      return $null
    }
  }
  return $null
}

function Get-LiveEnvHostingFacts {
  param(
    [string]$AppName = 'metasheet-backend',
    [string]$ScheduledTaskName = 'MetaSheet-PM2'
  )
  $me = Get-LiveEnvCurrentUser
  $pipe = Get-LiveEnvPipeState
  $taskFacts = Get-LiveEnvTaskFacts -TaskName $ScheduledTaskName -Me $me
  $homeInfo = Resolve-LiveEnvHomePath -TaskWord ([string]$taskFacts.Task)
  $homePath = [string]$homeInfo.Path
  $homeExists = $false
  if (-not [string]::IsNullOrWhiteSpace($homePath)) {
    $homeExists = Test-Path -LiteralPath $homePath -PathType Container
  }
  $homeInitialized = Test-LiveEnvHomeInitialized -HomePath $homePath
  $table = Get-LiveEnvProcessRows -Me $me
  $rows = @($table.Rows)

  $daemonPidFile = $false
  $daemonPid = 0
  if ($homeExists) {
    $daemonPidPath = Join-Path $homePath 'pm2.pid'
    $daemonPidFile = Test-Path -LiteralPath $daemonPidPath -PathType Leaf
    if ($daemonPidFile) { $daemonPid = Read-LiveEnvPidNumber -Path $daemonPidPath }
  }
  $daemonRow = Get-LiveEnvProcessByPid -Rows $rows -ProcessId $daemonPid
  $daemonAlive = $false
  $daemonOwner = 'false'
  if ($null -ne $daemonRow -and [bool]$daemonRow.IsNode) {
    $daemonAlive = $true
    $daemonOwner = [string]$daemonRow.OwnerWord
  }

  $appFiles = @()
  if ($homeExists) {
    $pidsDir = Join-Path $homePath 'pids'
    if (Test-Path -LiteralPath $pidsDir -PathType Container) {
      $prefix = $AppName + '-'
      $appFiles = @(Get-ChildItem -LiteralPath $pidsDir -File -Filter '*.pid' | Where-Object {
          $_.Name.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) -and
          ($_.Name.Substring($prefix.Length) -match '^\d+\.pid$')
        })
    }
  }
  $appAlive = $false
  $appOwner = 'false'
  $appOwners = @()
  $liveAppParents = @()
  foreach ($appFile in $appFiles) {
    $appPid = Read-LiveEnvPidNumber -Path $appFile.FullName
    $appRow = Get-LiveEnvProcessByPid -Rows $rows -ProcessId $appPid
    if ($null -ne $appRow -and [bool]$appRow.IsNode) {
      $appAlive = $true
      $appOwners += [string]$appRow.OwnerWord
      $liveAppParents += [int]$appRow.ParentPid
    }
  }
  if ($appAlive) {
    if ($appOwners -contains 'unknown') { $appOwner = 'unknown' }
    elseif ($appOwners -contains 'false') { $appOwner = 'false' }
    else { $appOwner = 'true' }
  }

  $runtimeRows = @()
  $stray = $false
  $strayUnknown = $false
  $pm2Other = 0
  $unreadable = 0
  foreach ($row in $rows) {
    if ($null -eq $row -or -not [bool]$row.IsNode) { continue }
    $commandLine = [string]$row.CommandLine
    if ([string]::IsNullOrEmpty($commandLine)) { $unreadable++; continue }
    $isGod = Test-LiveEnvGodCommandLine -CommandLine $commandLine
    $isRuntime = Test-LiveEnvRuntimeCommandLine -CommandLine $commandLine
    if ($isRuntime) { $runtimeRows += $row }
    if ($isGod -and [int]$row.Pid -ne $daemonPid) {
      if ([string]$row.OwnerWord -eq 'unknown') { $strayUnknown = $true } else { $stray = $true }
    }
    if ($commandLine -match 'pm2' -and [string]$row.OwnerWord -eq 'false') { $pm2Other++ }
    if ($commandLine -match 'pm2' -and [string]$row.OwnerWord -eq 'unknown') { $unreadable++ }
  }
  $strayWord = 'false'
  if ($strayUnknown) { $strayWord = 'unknown' }
  elseif ($stray) { $strayWord = 'true' }
  $otherUser = 'false'
  if ($pm2Other -gt 0) { $otherUser = 'true' }
  elseif ($unreadable -gt 0) { $otherUser = 'unknown' }

  $runtimeCount = $runtimeRows.Count
  $runtimeOwner = 'none'
  $runtimePid = 0
  if ($runtimeCount -eq 1) {
    $runtimeOwner = [string]$runtimeRows[0].OwnerWord
    $runtimePid = [int]$runtimeRows[0].Pid
  } elseif ($runtimeCount -gt 1) {
    $runtimeOwner = 'true'
    foreach ($runtimeRow in $runtimeRows) {
      if ([string]$runtimeRow.OwnerWord -eq 'unknown') { $runtimeOwner = 'unknown'; break }
      if ([string]$runtimeRow.OwnerWord -ne 'true') { $runtimeOwner = 'false' }
    }
  }
  $appParentIsRuntime = $false
  if ($appAlive -and $runtimePid -ne 0 -and $appOwner -eq 'true') {
    $appParentIsRuntime = $true
    foreach ($parentPid in $liveAppParents) {
      if ([int]$parentPid -ne $runtimePid) { $appParentIsRuntime = $false }
    }
  }

  return [pscustomobject]@{
    HomeSet              = [bool]$homeInfo.Set
    HomeExists           = [bool]$homeExists
    HomeInitialized      = [bool]$homeInitialized
    ResolvedHome         = $homePath
    DaemonPidFile        = [bool]$daemonPidFile
    DaemonAlive          = [bool]$daemonAlive
    DaemonOwner          = [string]$daemonOwner
    AppPidFile           = ($appFiles.Count -gt 0)
    AppAlive             = [bool]$appAlive
    AppOwner             = [string]$appOwner
    AppParentIsRuntime   = [bool]$appParentIsRuntime
    RuntimeTask          = [string]$taskFacts.Task
    RuntimeTaskState     = [string]$taskFacts.State
    RuntimeTaskOwner     = [string]$taskFacts.Owner
    RuntimeProcessCount  = [int]$runtimeCount
    RuntimeProcessOwner  = [string]$runtimeOwner
    StrayGod             = [string]$strayWord
    Pipe                 = [string]$pipe
    OtherUserPm2         = [string]$otherUser
    ProcessQuery         = [string]$table.Query
  }
}

function Format-LiveEnvBool {
  param([bool]$Value)
  if ($Value) { return 'true' }
  return 'false'
}

function Get-LiveEnvRuntimeOwnedWord {
  param($Facts)
  if ([string]$Facts.RuntimeProcessOwner -eq 'unknown') { return 'unknown' }
  if ([int]$Facts.RuntimeProcessCount -eq 1 -and [string]$Facts.RuntimeProcessOwner -eq 'true') { return 'true' }
  return 'false'
}

function Import-LiveEnvCiProbe {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { return }
  $text = [System.IO.File]::ReadAllText($Path, (New-Object System.Text.UTF8Encoding $false))
  $script:LiveEnvCiProbe = $text | ConvertFrom-Json
}

# --- env file / state words (03). Values never leave these functions except as words. ---

function Get-LiveEnvStateWord {
  param([object]$Value, [string]$Key, $Words)
  if ($null -eq $Value) { return 'absent' }
  $text = [string]$Value
  if ($text.Length -eq 0) { return 'empty' }
  if ($text -ceq 'true') { return 'literal-true' }
  if ($text.Trim() -match '^(?i)["'']?\s*true') { return 'loose-true' }
  if ($Words.ContainsKey($Key) -and $text -ceq $Words[$Key]) { return 'literal-' + $Words[$Key] }
  return 'exists'
}

function Read-LiveEnvFile {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  $text = [System.IO.File]::ReadAllText($Path, (New-Object System.Text.UTF8Encoding($false)))
  $map = @{}
  foreach ($raw in ($text -split "`r?`n")) {
    $line = $raw.Trim()
    if ($line.Length -eq 0 -or $line.StartsWith('#')) { continue }
    $eq = $line.IndexOf('=')
    if ($eq -le 0) { continue }
    $key = $line.Substring(0, $eq).Trim()
    $value = $line.Substring($eq + 1).Trim()
    if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    if (-not $map.ContainsKey($key)) { $map[$key] = New-Object System.Collections.ArrayList }
    [void]$map[$key].Add($value)
  }
  return $map
}

function Get-LiveEnvDbUrlRelation {
  param($RootFile, $DockerFile)
  $dbKey = 'DATABASE_URL'
  $cmp = [System.StringComparer]::Ordinal
  $sets = @()
  foreach ($fileMap in @($RootFile, $DockerFile)) {
    $fileSet = New-Object 'System.Collections.Generic.HashSet[string]' ($cmp)
    if ($null -ne $fileMap -and $fileMap.ContainsKey($dbKey)) {
      foreach ($dbValue in @($fileMap[$dbKey])) { [void]$fileSet.Add([string]$dbValue) }
    }
    $sets += , $fileSet
  }
  $rootCount = $sets[0].Count
  $dockerCount = $sets[1].Count
  $sets[0].UnionWith($sets[1])
  $unionCount = $sets[0].Count
  foreach ($fileSet in $sets) { $fileSet.Clear() }
  if ($rootCount -gt 1 -or $dockerCount -gt 1) { return 'differs' }
  if ($dockerCount -eq 0) { return 'docker_absent' }
  if ($rootCount -eq 0) { return 'root_absent' }
  if ($unionCount -eq 1) { return 'same' }
  return 'differs'
}

function Convert-LiveEnvBagValue {
  param([object]$Value)
  if ($null -eq $Value) { return '' }
  if ($Value -is [bool]) { if ($Value) { return 'true' }; return 'false' }
  if ($Value -is [string]) { return $Value }
  if ($Value -is [System.Collections.IDictionary] -or $Value -is [System.Array]) { return '[object]' }
  return [System.Convert]::ToString($Value, [System.Globalization.CultureInfo]::InvariantCulture)
}

function Test-LiveEnvBag {
  param($Value)
  return ($null -ne $Value -and ($Value -is [System.Collections.IDictionary] -or $Value -is [System.Management.Automation.PSCustomObject]))
}

function Get-LiveEnvBagKeys {
  param($Bag)
  if ($Bag -is [System.Collections.IDictionary]) { return @($Bag.Keys) }
  return @($Bag.PSObject.Properties.Name)
}

function Get-LiveEnvBagItem {
  param($Bag, [string]$Key)
  if ($Bag -is [System.Collections.IDictionary]) { return $Bag[$Key] }
  return $Bag.$Key
}

function Get-LiveEnvDbUrlProcess {
  param([string]$Pm2Read, $EnvBags, $DockerFile)
  if ($Pm2Read -ne 'ok') { return 'unknown' }
  $dbKey = 'DATABASE_URL'
  $cmp = [System.StringComparer]::Ordinal
  $values = New-Object 'System.Collections.Generic.HashSet[string]' ($cmp)
  foreach ($bag in @($EnvBags)) {
    if (-not (Test-LiveEnvBag $bag)) { continue }
    foreach ($bagKey in @(Get-LiveEnvBagKeys $bag)) {
      if ([string]::Equals([string]$bagKey, $dbKey, [System.StringComparison]::OrdinalIgnoreCase)) {
        [void]$values.Add((Convert-LiveEnvBagValue (Get-LiveEnvBagItem $bag ([string]$bagKey))))
      }
    }
  }
  $processCount = $values.Count
  $dockerCount = 0
  if ($null -ne $DockerFile -and $DockerFile.ContainsKey($dbKey)) {
    foreach ($dbValue in @($DockerFile[$dbKey])) { [void]$values.Add([string]$dbValue); $dockerCount++ }
  }
  $unionCount = $values.Count
  $values.Clear()
  if ($processCount -eq 0) { return 'absent' }
  if ($dockerCount -eq 0) { return 'unknown' }
  if ($unionCount -eq 1) { return 'same' }
  return 'differs'
}

function ConvertFrom-LiveEnvJlistText {
  param([string]$Text)
  if ([string]::IsNullOrEmpty($Text)) { return $null }
  if ($Text[0] -eq [char]0xFEFF) { $Text = $Text.Substring(1) }
  $start = [regex]::Match($Text, '(?m)^[ \t]*\[[ \t\r\n]*[\{\]]')
  $end = $Text.LastIndexOf(']')
  if (-not $start.Success -or $end -le $start.Index) { return $null }
  $json = $Text.Substring($start.Index, $end - $start.Index + 1)
  $parsed = $null
  $serializerReady = $false
  try {
    Add-Type -AssemblyName System.Web.Extensions -ErrorAction Stop
    $serializerReady = $true
  } catch {
    $serializerReady = $false
  }
  if ($serializerReady) {
    try {
      $serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
      $serializer.MaxJsonLength = [int]::MaxValue
      $serializer.RecursionLimit = 512
      $parsed = $serializer.DeserializeObject($json)
    } catch {
      return $null
    }
  } else {
    # Windows PowerShell 5.1 keeps both Path and PATH. PowerShell 7's ConvertFrom-Json
    # does not. Fail closed instead of dropping one of them. Field runs use 5.1.
    # -cmatch: PowerShell -match is case-insensitive, so "PATH" alone would look like both keys.
    if ($json -cmatch '(?<=[{,])\s*"Path"\s*:' -and $json -cmatch '(?<=[{,])\s*"PATH"\s*:') { return $null }
    try { $parsed = $json | ConvertFrom-Json } catch { return $null }
    # PowerShell 7 unwraps a one-element JSON array into the element itself, and
    # turns [] into $null. Windows PowerShell 5.1 uses JavaScriptSerializer above.
    if ($null -eq $parsed) {
      if ($json.Trim() -eq '[]') { return @() }
      return $null
    }
    return @($parsed)
  }
  if ($parsed -is [System.Array]) { return $parsed }
  return $null
}

function Resolve-LiveEnvPm2Command {
  param([string]$InstallRoot)
  $localPm2 = Join-Path (Join-Path (Join-Path $InstallRoot 'node_modules') '.bin') 'pm2.cmd'
  if (Test-Path -LiteralPath $localPm2 -PathType Leaf) {
    return [pscustomobject]@{ Kind = 'local'; Path = $localPm2 }
  }
  $pathEntries = New-Object System.Collections.ArrayList
  foreach ($entry in ([string][Environment]::GetEnvironmentVariable('PATH', 'Process') -split ';')) {
    if (-not [string]::IsNullOrWhiteSpace($entry)) { [void]$pathEntries.Add($entry) }
  }
  if ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT) {
    $candidates = @()
    foreach ($base in @([Environment]::GetEnvironmentVariable('ProgramFiles'), [Environment]::GetEnvironmentVariable('ProgramFiles(x86)'), 'C:\Program Files', 'C:\Program Files (x86)')) {
      if (-not [string]::IsNullOrWhiteSpace($base)) { $candidates += (Join-Path $base 'nodejs') }
    }
    $npmBases = @($env:APPDATA)
    if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) { $npmBases += (Join-Path $env:USERPROFILE 'AppData\Roaming') }
    foreach ($base in $npmBases) {
      if (-not [string]::IsNullOrWhiteSpace($base)) { $candidates += (Join-Path $base 'npm') }
    }
    $sysRoot = if ([string]::IsNullOrWhiteSpace($env:SystemRoot)) { 'C:\Windows' } else { $env:SystemRoot }
    $candidates += @((Join-Path $sysRoot 'System32'), $sysRoot)
    foreach ($candidate in ($candidates | Select-Object -Unique)) {
      if ([string]::IsNullOrWhiteSpace($candidate) -or -not (Test-Path -LiteralPath $candidate)) { continue }
      $present = $false
      foreach ($entry in $pathEntries) {
        if ($entry.TrimEnd('\') -eq $candidate.TrimEnd('\')) { $present = $true; break }
      }
      if (-not $present) { $pathEntries.Insert(0, $candidate) }
    }
  }
  foreach ($entry in $pathEntries) {
    $tryPath = Join-Path $entry.Trim().Trim('"') 'pm2.cmd'
    if (Test-Path -LiteralPath $tryPath -PathType Leaf) {
      return [pscustomobject]@{ Kind = 'path'; Path = $tryPath }
    }
  }
  return [pscustomobject]@{ Kind = 'none'; Path = '' }
}

function Invoke-LiveEnvPm2Jlist {
  param(
    [string]$Pm2Path,
    [string]$ChildHome,
    [bool]$SetChildHome,
    [int]$TimeoutSeconds
  )
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.UseShellExecute = $false
  $windowsHost = [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT
  if ($windowsHost) {
    $psi.FileName = if ([string]::IsNullOrWhiteSpace($env:ComSpec)) { 'cmd.exe' } else { $env:ComSpec }
    $psi.Arguments = '/d /s /c ""' + $Pm2Path + '" jlist"'
  } else {
    # PowerShell 7's argument string is not a safe way to pass one path. ArgumentList
    # exists there and is argv, verbatim. Windows PowerShell 5.1 uses the cmd.exe
    # branch above and has no ArgumentList.
    $psi.FileName = '/bin/sh'
    [void]$psi.ArgumentList.Add($Pm2Path)
    [void]$psi.ArgumentList.Add('jlist')
  }
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.RedirectStandardInput = $true
  $utf8 = New-Object System.Text.UTF8Encoding $false
  $psi.StandardOutputEncoding = $utf8
  $psi.StandardErrorEncoding = $utf8
  if ($psi.EnvironmentVariables.ContainsKey('PM2_DISCRETE_MODE')) {
    [void]$psi.EnvironmentVariables.Remove('PM2_DISCRETE_MODE')
  }
  if ($SetChildHome) { $psi.EnvironmentVariables['PM2_HOME'] = $ChildHome }
  $proc = $null
  try { $proc = [System.Diagnostics.Process]::Start($psi) } catch {
    return [pscustomobject]@{ Status = 'failed'; Text = '' }
  }
  $proc.StandardInput.Close()
  $outTask = $proc.StandardOutput.ReadToEndAsync()
  $errTask = $proc.StandardError.ReadToEndAsync()
  if (-not $proc.WaitForExit($TimeoutSeconds * 1000)) {
    try { $proc.Kill() } catch { }
    return [pscustomobject]@{ Status = 'timeout'; Text = '' }
  }
  $proc.WaitForExit()
  $text = $outTask.Result
  $null = $errTask.Result
  if ($proc.ExitCode -ne 0) { return [pscustomobject]@{ Status = 'failed'; Text = '' } }
  return [pscustomobject]@{ Status = 'ok'; Text = $text }
}
