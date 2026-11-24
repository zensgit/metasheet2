# 03-live-env-check.ps1 (v2, package 3) - values-free check of switch keys in the LIVE backend process
# environment (pm2) and in both app.env files. Windows PowerShell 5.1, read-only.
#
# RUN (in the window that step 2 checked, right after 02-pm2-owner-check.ps1 answered owned=true):
#   powershell -NoProfile -ExecutionPolicy Bypass -File 03-live-env-check.ps1 -InstallRoot '<install root>'
#   optional: -Keys 'KEY_A,KEY_B'   (default: the built-in list below; the LIVEENV_RESULT line prints how
#             many keys were checked, so the sheet never needs a hand-typed count)
#
# v2 CHANGES vs R85 (R85 file sha256 86b24d63...):
#   - 8 package-3 keys added to the default list (6 boolean, 2 list), kinds from
#     scripts/ops/global-history-flag-manifest.mjs@59876b3d6.
#   - new state words: blank (non-empty, but only whitespace after Trim, e.g. KEY=" ") and literal-false
#     (exactly: false). In R85 both were reported as exists.
#   - each LIVEENV key line now ends with kind=, gate= and verdict=, and a LIVEENV_GATE summary line comes
#     right before LIVEENV_RESULT. The gate rules are in GATE below.
#   - judge fixes 2026-11-17: a file column is the worst line, not the last line (F1); new line
#     LIVEENV_DBURL (root vs docker DATABASE_URL, compared in memory only).
#   - judge round 2, 2026-11-17: LIVEENV_DBURL compares each file's own lines first (two values in one
#     file are differs even when the other file has no line); new line LIVEENV_DBURL_PROCESS (the live
#     pm2 env DATABASE_URL vs docker\app.env's, in memory only).
#
# WHY: a key deleted from app.env can stay in the running backend. pm2 restart --update-env merges the
# variables present at restart time and does not drop a variable that is no longer in the file (delivery
# guide section "memo switch off", seen on a test machine). The start script clears only its two retired
# test keys (attendance-onprem-start-pm2.ps1 :8-11, :99-110). So app.env alone does not tell what the
# backend reads; this script reads the process environment that pm2 holds for the app.
#
# HOW:
#   files     <root>\app.env and <root>\docker\app.env, parsed like the start script (:48-73): trimmed,
#             blank and # lines skipped, KEY=value split at the first '=', one pair of matching quotes
#             stripped. Both files are reported. When one file holds a key on several lines, readers
#             disagree on which line wins: the start script (:48-73, ROOT file when it exists, else
#             docker, :31-46) and apply-package (docker\app.env by default, multitable-onprem-apply-
#             package.ps1 :88, :1064-1066) import every line, so the LAST line wins; ecosystem.config.cjs
#             (:42, called at :52) reads docker\app.env and sets only keys not already set, so there the
#             FIRST line wins (reached on a pm2 start / delete-then-start, start script :336-344). So each file column
#             shows the line with the WORST verdict for the key's gate (then the higher rank), never
#             just the last line, and dup= says when the lines differ.
#   DATABASE_URL  apply-package migrates with docker\app.env's DATABASE_URL (:1079, :1282) and then runs
#             the start script in the same process, which imports the ROOT file on top (:1301; start
#             script :350-352). LIVEENV_DBURL compares the two files' DATABASE_URL values IN MEMORY
#             ONLY (ordinal, case-sensitive) and prints one word; never a value, length or hash.
#             When the root file has no DATABASE_URL, pm2 restart --update-env keeps the value pm2
#             holds, while step 20 restarts the backend inside apply-package's process, which carries
#             docker\app.env's value: the backend can move to another database with every file read
#             unchanged. LIVEENV_DBURL_PROCESS compares the pm2 env value with docker\app.env's, in
#             memory only, the same way.
#   process   only when <PM2_HOME>\pm2.pid names a live node.exe owned by the current account (the same
#             rule as 02-pm2-owner-check.ps1); otherwise NO pm2 command runs (a pm2 command with no
#             daemon starts a new, empty one). pm2 is the install root's node_modules\.bin\pm2.cmd when
#             present, else pm2.cmd on PATH (the start script's choice, :228-237), searched after adding the
#             nodejs / npm / Windows folders the start script adds first (:112-177, called at :354). `pm2 jlist` output is
#             read into memory as UTF-8 (never a file, never printed) and parsed with the .NET
#             JavaScriptSerializer, whose keys are case-sensitive. ConvertFrom-Json is NOT used: on
#             Windows PowerShell 5.1 it rejects the whole document when the env holds both Path and
#             PATH (F: stock-preparation-pm2-sample.mjs header; start script :271 uses it and can fall
#             back). Leading noise lines (BOM, [PM2] notices) are skipped. Exactly one app named
#             metasheet-backend must be listed. A key is looked up case-insensitively (Windows env
#             names) in pm2_env and in pm2_env.env (the start script reads pm2_env, :313). Canary: PATH
#             must be visible in one of the two bags, else the answer is incomplete (env_not_visible),
#             never absent.
#   machine / user   the Windows machine-level and user-level environment of this account.
#
# STATE WORDS (never a value):
#   absent          no such key (or no such file)
#   empty           the key is set to an empty value (in a file: KEY= ; see the PS 5.1 note in GATE)
#   blank           the value is not empty but is only whitespace after Trim (KEY=" " in a file gives one
#                   space). The list readers treat it as unset: yida-issue-confirm-writeback.cjs:164 trims;
#                   yida-owner-runtime.ts:186-189 does not trim, a single space fails the TARGET_REF test at
#                   :188 and gives the empty set; the path reader trims (plugin-runtime-config.ts:72)
#                   (all @59876b3d6).
#   literal-true    the value is exactly: true   (what code testing === 'true' reads as ON)
#   loose-true      not literal-true, but it starts like true after trimming and one quote, any case
#                   (TRUE, 'true, true1 ...). Code with exact tests reads it as off; report it.
#   literal-false   the value is exactly: false  (the boolean switch-off form)
#   literal-production / literal-mock   only for NODE_ENV / MULTITABLE_EMAIL_TRANSPORT
#   exists          any other non-empty value
#   valid-integer   only for the strict session max age, when within the runtime bounds
#   unknown         (process only) the process environment was not read; see LIVEENV_RESULT
#
# GATE (per key; columns process, launch, root, docker, machine, user; the worst column wins: on > review >
# unknown > off). The kind and gate of each default key are in $Spec below.
#   gate=true-stops      (booleans) on = literal-true. off = absent or literal-false. Anything else
#                        (loose-true, empty, blank, exists) = review: code with an exact test reads it as
#                        off, but it is not the switch-off form, and some readers fold case or accept 1
#                        (plugin-runtime-config.ts:94-98@59876b3d6), so the owner decides.
#   gate=value-stops     (list / path / json keys) off = absent or blank (KEY=" " is the switch-off form).
#                        on = any value with a non-space character (true, false, a list, a path).
#                        empty = review: on PS 5.1 the start script's Set-Item Env:KEY with an empty value
#                        removes the variable, so pm2 restart --update-env keeps the OLD value in the
#                        process; never use KEY= to switch a list or path key off.
#   gate=numeric-stops (strict session max age) on = accepted integer; off = absent.
#                        All other states, including empty and blank, require review.
#   gate=nonfalse-stops  (RBAC_BYPASS only) off = absent or literal-false; anything else = on.
#   gate=record          (install sheet step 4 keys) not gated: verdict=- ; read the state words.
#   gate=unlisted        (a -Keys name that is not in $Spec) off = absent; anything else = review.
#   machine= / user= : any state other than absent is at least review (the pm2 daemon inherits it).
#   Several lines for one key in one file: the file column is the worst line, so on a GATED key
#   dup=differs always comes with a verdict of at least review (every gate has at most one off state a
#   line can hold). A gate=record key has verdict=- whatever dup says, and nothing counts its dup=differs:
#   read the line and report it.
#   LIVEENV_DBURL relation=differs counts 1 in LIVEENV_GATE review=, and LIVEENV_DBURL_PROCESS
#   process=differs counts 1 more (neither has a key line), so the pass rule stays: LIVEENV_GATE on=0
#   review=0 unknown=0 and LIVEENV_RESULT ... status=complete. relation=docker_absent is a stop on the
#   install sheet (no DATABASE_URL for step 20 to migrate with), not in this gate.
#
# OUTPUT (closed lines only; never a path, account, PID, command line or value):
#   LIVEENV_FILE root=found|absent docker=found|absent start_script_uses=root|docker|none
#   LIVEENV_DBURL relation=same|differs|root_absent|docker_absent
#       checked in this order: first each file's own lines (one file holding two different values is
#       differs, whatever the other file holds), then the absent words, then the two files together
#       differs       = any two DATABASE_URL lines (in either file, or across the two) differ, even
#                       only in case; an empty value counts as a value. The gate stops (review +1).
#       docker_absent = docker\app.env missing, or no DATABASE_URL line in it
#       root_absent   = root app.env missing, or no DATABASE_URL line in it
#       same          = every DATABASE_URL line of both files holds the identical value
#   LIVEENV_PM2 pm2_home_set=true|false daemon_alive=true|false daemon_owner_is_current_user=true|false|unknown pm2_cmd=local|path|none read=ok|skipped|failed app_matches=<n>|-
#   LIVEENV_DBURL_PROCESS process=same|differs|absent|unknown
#       the running backend's DATABASE_URL (both pm2_env bags, key name case-insensitive) against every
#       DATABASE_URL line of docker\app.env, the file step 20 migrates with and restarts the backend from.
#       Checked in this order:
#       unknown = the process env was not read (see LIVEENV_RESULT)
#       absent  = read, and the process env holds no DATABASE_URL
#       unknown = docker\app.env has no DATABASE_URL line (LIVEENV_DBURL then says docker_absent)
#       same    = one value across every process occurrence and every docker line
#       differs = otherwise, even only in case. The gate stops (review +1).
#   LIVEENV_BACKEND generation=fresh|stale|wrong_app|wrong_peer|unknown (only with -StartedAfterUtc)
#       fresh = the named online app from this root has an OS start time after the caller's UTC cutoff.
#       -HealthPeerPid is an internal input from H01 for the direct connection's owner.
#   LIVEENV_BACKEND target=verified|unconfirmed (only with -ExpectedPm2Command)
#   LIVEENV key=<KEY> process=<w> launch=<w> root=<w> docker=<w> machine=<w> user=<w> dup=none|same|differs pdup=none|same|differs kind=<k> gate=<g> verdict=off|on|review|unknown|-
#       launch = this shell's inherited process environment, separate from the live PM2 app.
#       dup  = several lines for the key in one file (same / differing state words); root= and
#              docker= then show the line with the worst verdict
#       pdup = the key found more than once in the process env (case variants, or both pm2_env bags);
#              process= then shows the occurrence with the worst verdict
#       kind = boolean|list|path|json|enum|unlisted
#   LIVEENV_GATE on=<n> review=<n> unknown=<n> off=<n> record=<n>
#   then the LAST line
#   LIVEENV_RESULT keys=<n> status=complete
#   LIVEENV_RESULT keys=<n> status=incomplete reason=<word>
# A run with no LIVEENV_RESULT line did not finish. Never read a missing line as absent.
# reasons: install_root_not_found, bad_key, no_daemon, daemon_not_owned, owner_unreadable, pm2_not_found,
# pm2_timeout, pm2_failed, parse_failed, app_count, env_not_visible, parser_unavailable,
# invalid_start_cutoff, backend_generation_unconfirmed, pm2_command_mismatch, backend_target_unconfirmed, read_error.
param(
  [Parameter(Mandatory = $true)][string]$InstallRoot,
  [string[]]$Keys = @(),
  [string]$AppName = 'metasheet-backend',
  [int]$TimeoutSeconds = 60,
  [string]$StartedAfterUtc,
  [ValidateRange(1, 2147483647)][int]$HealthPeerPid,
  [string]$ExpectedPm2Command
)

$ErrorActionPreference = 'Stop'

# key -> kind, gate. Order = output order. Kinds: manifest type at 59876b3d6 for the 29 keys it lists
# (path = manifest 'enum' that names a deploy-local file). 6 keys are not in the manifest: RBAC_BYPASS and
# the two C6 keys were read from code (exact 'true' / parseBooleanEnv / trim-empty JSON); WECOM,
# MULTITABLE_EMAIL_TRANSPORT and NODE_ENV are record-only and keep their R85 treatment.
$Spec = [ordered]@{
  # install sheet step 3 (gated)
  'SECURITY_ACTION_PROOF_ENABLED'                    = @('boolean', 'true-stops')
  'DIRECTORY_INTEGRATION_CAPABILITIES_ENABLED'       = @('boolean', 'true-stops')
  'DINGTALK_INTEGRATION_SCOPED_CREDENTIALS_ENABLED'  = @('boolean', 'true-stops')
  'APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED'          = @('boolean', 'true-stops')
  'USER_NOTIFICATION_PREFERENCES_ENABLED'            = @('boolean', 'true-stops')
  'USER_RECYCLE_SWEEPER_ENABLED'                     = @('boolean', 'true-stops')
  'STOCK_PREP_PULL_BATCH_ENABLED'                    = @('boolean', 'true-stops')
  'MULTITABLE_STOCK_PREP_SHEET_REPAIR_WRITE_ENABLED' = @('boolean', 'true-stops')
  'INTEGRATION_YIDA_OWNER_SEND_ENABLED'              = @('boolean', 'true-stops')
  'INTEGRATION_YIDA_MULTI_TARGET_ENABLED'            = @('boolean', 'true-stops')
  'INTEGRATION_YIDA_CONNECTION_TEST_ENABLED'         = @('boolean', 'true-stops')
  'RBAC_BYPASS'                                      = @('boolean', 'nonfalse-stops')
  'TASKS_ENABLED'                                    = @('boolean', 'true-stops')
  'TASKS_SCHEDULER_ENABLED'                          = @('boolean', 'true-stops')
  'TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED'       = @('boolean', 'true-stops')
  'INTEGRATION_CORE_STOCK_PREPARATION_PILOT_PATH'    = @('path', 'value-stops')
  'METASHEET_C6_TEST_FAILURE_INJECTION_ENABLED'      = @('boolean', 'true-stops')
  'INTEGRATION_CORE_C6_TEST_FAILURE_INJECTION_JSON'  = @('json', 'value-stops')
  'INTEGRATION_AUTOMATION_RUN_ACTION_ENABLED'        = @('boolean', 'true-stops')
  'INTEGRATION_AUTOMATION_RUN_EVENT_ENABLED'         = @('boolean', 'true-stops')
  # package 3 additions (pre-audit R6; manifest @59876b3d6)
  # YiDa top-stack extension (R-88): sheet sources require exact true.
  'INTEGRATION_YIDA_SHEET_SOURCE_ENABLED'            = @('boolean', 'true-stops')
  'INTEGRATION_YIDA_ISSUE_CONFIRM_WRITEBACK_ENABLED'  = @('boolean', 'true-stops')
  'INTEGRATION_YIDA_RECONCILE_READ_ENABLED'          = @('boolean', 'true-stops')
  'AUTOMATION_SYNTHETIC_INTEGRATION_PREVIEW_ENABLED' = @('boolean', 'true-stops')
  'INTEGRATION_AUTOMATION_RUN_APPLY_ENABLED'         = @('boolean', 'true-stops')
  'INTEGRATION_AUTOMATION_RUN_PIPELINE_WRITE_ENABLED' = @('boolean', 'true-stops')
  'DELEGATED_SCOPE_EXACT_DEPARTMENT_ENABLED'         = @('boolean', 'true-stops')
  'INTEGRATION_YIDA_ISSUE_CONFIRM_TARGET_REFS'       = @('list', 'value-stops')
  'INTEGRATION_YIDA_UNBOUND_TEST_TARGET_REFS'        = @('list', 'value-stops')
  # Permission changes added after the initial P3 draft.
  'DELEGATED_SCOPE_ACTIVATION_ENABLED'               = @('boolean', 'true-stops')
  'EXTERNAL_LOGIN_STRICT_SESSION_MAX_AGE_SECONDS'    = @('numeric', 'numeric-stops')
  'DIRECTORY_DEPROVISION_REVOKE_CREDENTIALS_ENABLED' = @('boolean', 'true-stops')
  # install sheet step 4 (record only)
  'AUTOMATION_CLASSB_OUTBOUND_ENABLED'               = @('boolean', 'record')
  'MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED'      = @('boolean', 'record')
  'DINGTALK_TODO_MIRROR_ENABLED'                     = @('boolean', 'record')
  'ATTENDANCE_NOTIFICATION_WECOM_ENABLED'            = @('boolean', 'record')
  'MULTITABLE_EMAIL_TRANSPORT'                       = @('enum', 'record')
  'NODE_ENV'                                         = @('enum', 'record')
  'MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED'     = @('boolean', 'record')
}
$DefaultKeys = @($Spec.Keys)
$Words = @{ 'NODE_ENV' = 'production'; 'MULTITABLE_EMAIL_TRANSPORT' = 'mock' }
$Rank = @{ 'absent' = 0; 'empty' = 1; 'blank' = 2; 'literal-false' = 3; 'exists' = 4; 'literal-production' = 4; 'literal-mock' = 4; 'loose-true' = 5; 'literal-true' = 6; 'valid-integer' = 6; 'unknown' = 7 }
$VRank = @{ 'off' = 0; 'unknown' = 1; 'review' = 2; 'on' = 3 }

function Get-State([object]$value, [string]$key) {
  if ($null -eq $value) { return 'absent' }
  $s = [string]$value
  if ($s.Length -eq 0) { return 'empty' }
  if ($s -ceq 'true') { return 'literal-true' }
  if ($s.Trim().Length -eq 0) { return 'blank' }
  if ($s.Trim() -match '^(?i)["'']?\s*true') { return 'loose-true' }
  if ($s -ceq 'false') { return 'literal-false' }
  if ($Words.ContainsKey($key) -and $s -ceq $Words[$key]) { return 'literal-' + $Words[$key] }
  # Match readConfiguredStrictSessionMaxAgeSeconds in strict-dingtalk-entry.ts.
  if ($key -eq 'EXTERNAL_LOGIN_STRICT_SESSION_MAX_AGE_SECONDS' -and $s -cmatch '^[1-9][0-9]*$') {
    $seconds = 0L
    if ([long]::TryParse($s, [ref]$seconds) -and $seconds -ge 300 -and $seconds -le 2592000) {
      return 'valid-integer'
    }
  }
  return 'exists'
}

function Get-KeySpec([string]$key) {
  # case-insensitive like Windows env names; $Spec is an ordered dictionary
  foreach ($k in $Spec.Keys) { if ([string]::Equals([string]$k, $key, [System.StringComparison]::OrdinalIgnoreCase)) { return $Spec[$k] } }
  return @('unlisted', 'unlisted')
}

function Get-Verdict([string]$state, [string]$gate) {
  if ($state -eq 'unknown') { return 'unknown' }
  switch ($gate) {
    'true-stops' {
      if ($state -eq 'absent' -or $state -eq 'literal-false') { return 'off' }
      if ($state -eq 'literal-true') { return 'on' }
      return 'review'
    }
    'value-stops' {
      if ($state -eq 'absent' -or $state -eq 'blank') { return 'off' }
      if ($state -eq 'empty') { return 'review' }
      return 'on'
    }
    'numeric-stops' {
      if ($state -eq 'absent') { return 'off' }
      if ($state -eq 'valid-integer') { return 'on' }
      return 'review'
    }
    'nonfalse-stops' {
      if ($state -eq 'absent' -or $state -eq 'literal-false') { return 'off' }
      return 'on'
    }
    default {
      if ($state -eq 'absent') { return 'off' }
      return 'review'
    }
  }
}

function Get-WorseVerdict([string]$a, [string]$b) { if ($VRank[$b] -gt $VRank[$a]) { return $b } return $a }

function Read-EnvFile([string]$path) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
  $text = [System.IO.File]::ReadAllText($path, (New-Object System.Text.UTF8Encoding($false)))
  $map = @{}
  foreach ($raw in ($text -split "`r?`n")) {
    $line = $raw.Trim()
    if ($line.Length -eq 0 -or $line.StartsWith('#')) { continue }
    $eq = $line.IndexOf('=')
    if ($eq -le 0) { continue }
    $k = $line.Substring(0, $eq).Trim()
    $v = $line.Substring($eq + 1).Trim()
    if ($v.Length -ge 2 -and (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'")))) {
      $v = $v.Substring(1, $v.Length - 2)
    }
    if (-not $map.ContainsKey($k)) { $map[$k] = New-Object System.Collections.ArrayList }
    [void]$map[$k].Add($v)
  }
  return $map
}

function Get-DbUrlRelation($rootFile, $dockerFile) {
  # values stay in this function; only one word leaves it
  $dk = 'DATABASE_URL'
  $cmp = [System.StringComparer]::Ordinal
  $sets = @()
  foreach ($fm in @($rootFile, $dockerFile)) {
    $fs = New-Object 'System.Collections.Generic.HashSet[string]' ($cmp)
    if ($null -ne $fm -and $fm.ContainsKey($dk)) { foreach ($dv in @($fm[$dk])) { [void]$fs.Add([string]$dv) } }
    $sets += , $fs
  }
  $rootN = $sets[0].Count; $dockerN = $sets[1].Count
  $sets[0].UnionWith($sets[1]); $n = $sets[0].Count
  foreach ($fs in $sets) { $fs.Clear() }
  $sets = $null
  # each file's own lines first: one file holding two values differs, whatever the other file holds
  if ($rootN -gt 1 -or $dockerN -gt 1) { return 'differs' }
  if ($dockerN -eq 0) { return 'docker_absent' }
  if ($rootN -eq 0) { return 'root_absent' }
  if ($n -eq 1) { return 'same' }
  return 'differs'
}

function Get-DbUrlProcess([string]$pm2Read, $envBags, $dockerFile) {
  # values stay in this function; only one word leaves it. The live pm2 env DATABASE_URL against
  # docker\app.env's, the file step 20 migrates with and restarts the backend from.
  if ($pm2Read -ne 'ok') { return 'unknown' }
  $dk = 'DATABASE_URL'
  $pcmp = [System.StringComparer]::Ordinal
  $pset = New-Object 'System.Collections.Generic.HashSet[string]' ($pcmp)
  foreach ($bag in @($envBags)) {
    foreach ($bk in @($bag.Keys)) {
      if ([string]::Equals([string]$bk, $dk, [System.StringComparison]::OrdinalIgnoreCase)) { [void]$pset.Add((Convert-EnvValue $bag[$bk])) }
    }
  }
  $pn = $pset.Count
  $dn = 0
  if ($null -ne $dockerFile -and $dockerFile.ContainsKey($dk)) { foreach ($dv in @($dockerFile[$dk])) { [void]$pset.Add([string]$dv); $dn++ } }
  $pall = $pset.Count
  $pset.Clear(); $pset = $null
  if ($pn -eq 0) { return 'absent' }
  if ($dn -eq 0) { return 'unknown' }
  if ($pall -eq 1) { return 'same' }
  return 'differs'
}

function Get-ProcessById([int]$ProcessId) {
  if ($ProcessId -le 0) { return $null }
  return (Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId=' + $ProcessId) | Select-Object -First 1)
}

function Get-BackendGeneration($App, [DateTimeOffset]$After) {
  if ($null -eq $App -or $App['pm2_env']['status'] -cne 'online') { return 'unknown' }
  $processId = 0
  if (-not [int]::TryParse([string]$App['pid'], [ref]$processId) -or $processId -le 0) { return 'unknown' }
  if ($HealthPeerPid -gt 0 -and $processId -ne $HealthPeerPid) { return 'wrong_peer' }
  try {
    $expected = [IO.Path]::GetFullPath((Join-Path $InstallRoot 'packages\core-backend\dist\src\index.js'))
    $scriptPath = [string]$App['pm2_env']['pm_exec_path']
    if (-not [IO.Path]::IsPathRooted($scriptPath)) { return 'wrong_app' }
    $expected = (Get-Item -LiteralPath $expected).FullName
    $actual = (Get-Item -LiteralPath $scriptPath).FullName
    if ($actual -ine $expected) { return 'wrong_app' }
    $started = (Get-Process -Id $processId -ErrorAction Stop).StartTime.ToUniversalTime()
    if ($started -gt $After.UtcDateTime) { return 'fresh' }
    return 'stale'
  } catch { return 'unknown' }
}

function Get-OwnerIsCurrent($proc, [string]$me) {
  if ($null -eq $proc) { return 'false' }
  try { $o = Invoke-CimMethod -InputObject $proc -MethodName GetOwner } catch { return 'unknown' }
  if ($null -eq $o -or [int]$o.ReturnValue -ne 0 -or [string]::IsNullOrEmpty([string]$o.User)) { return 'unknown' }
  $owner = ([string]$o.Domain + '\' + [string]$o.User)
  if ([string]::Equals($owner, $me, [System.StringComparison]::OrdinalIgnoreCase)) { return 'true' }
  return 'false'
}

function Read-PidFile([string]$path) {
  try { $raw = ([string](Get-Content -LiteralPath $path -Raw)).Trim() } catch { return 0 }
  if ($raw -match '^\d{1,10}$') { return [int]$raw }
  return 0
}

function Out-Bool([bool]$b) { if ($b) { return 'true' } return 'false' }

function Convert-EnvValue([object]$v) {
  if ($null -eq $v) { return '' }
  if ($v -is [bool]) { if ($v) { return 'true' } return 'false' }
  if ($v -is [string]) { return $v }
  if ($v -is [System.Collections.IDictionary] -or $v -is [System.Array]) { return '[object]' }
  return [System.Convert]::ToString($v, [System.Globalization.CultureInfo]::InvariantCulture)
}

$keyList = @()
$resultLine = $null
try {
  # key list (-File passes an array as one comma-joined string)
  $src = if ($Keys.Count -gt 0) { $Keys } else { $DefaultKeys }
  foreach ($k in $src) { foreach ($part in ([string]$k -split ',')) { $p = $part.Trim(); if ($p.Length -gt 0) { $keyList += $p } } }
  foreach ($k in $keyList) {
    if ($k -notmatch '^[A-Za-z_][A-Za-z0-9_]{0,127}$') {
      'LIVEENV_RESULT keys=0 status=incomplete reason=bad_key'
      exit 2
    }
  }

  if (-not (Test-Path -LiteralPath $InstallRoot -PathType Container)) {
    'LIVEENV_FILE root=absent docker=absent start_script_uses=none'
    'LIVEENV_RESULT keys=' + $keyList.Count + ' status=incomplete reason=install_root_not_found'
    exit 2
  }
  $rootMap = Read-EnvFile (Join-Path $InstallRoot 'app.env')
  $dockerMap = Read-EnvFile (Join-Path (Join-Path $InstallRoot 'docker') 'app.env')
  $uses = if ($null -ne $rootMap) { 'root' } elseif ($null -ne $dockerMap) { 'docker' } else { 'none' }
  'LIVEENV_FILE root={0} docker={1} start_script_uses={2}' -f $(if ($null -ne $rootMap) { 'found' } else { 'absent' }), $(if ($null -ne $dockerMap) { 'found' } else { 'absent' }), $uses
  $dbRel = Get-DbUrlRelation $rootMap $dockerMap
  'LIVEENV_DBURL relation=' + $dbRel

  # ---- daemon guard (no pm2 command unless this account's daemon is alive) ----
  $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $homeSet = -not [string]::IsNullOrWhiteSpace($env:PM2_HOME)
  if ($homeSet) { $pm2Home = $env:PM2_HOME } else {
    $profileRoot = $env:USERPROFILE
    if ([string]::IsNullOrWhiteSpace($profileRoot)) {
      $sysRoot = if ([string]::IsNullOrWhiteSpace($env:SystemRoot)) { 'C:\Windows' } else { $env:SystemRoot }
      $profileRoot = Join-Path $sysRoot 'System32\config\systemprofile'
    }
    $pm2Home = Join-Path $profileRoot '.pm2'
  }
  $daemonAlive = $false
  $daemonOwner = 'false'
  $pidPath = Join-Path $pm2Home 'pm2.pid'
  if (Test-Path -LiteralPath $pidPath -PathType Leaf) {
    $dproc = Get-ProcessById (Read-PidFile $pidPath)
    if ($null -ne $dproc -and [string]$dproc.Name -ieq 'node.exe') {
      $daemonAlive = $true
      $daemonOwner = Get-OwnerIsCurrent $dproc $me
    }
  }

  $pm2Kind = 'none'
  $pm2Path = $null
  $readState = 'skipped'
  $appMatches = '-'
  $pm2Env = $null
  $localPm2 = Join-Path $InstallRoot 'node_modules\.bin\pm2.cmd'
  if (Test-Path -LiteralPath $localPm2 -PathType Leaf) { $pm2Kind = 'local'; $pm2Path = $localPm2 }
  else {
    # the start script first prepends these folders to PATH when they exist (Initialize-WindowsSystemToolPath,
    # :112-177, called at :354 before pm2 is resolved at :364), so search the same PATH it would have
    $pathEntries = New-Object System.Collections.ArrayList
    foreach ($e in ([string][Environment]::GetEnvironmentVariable('PATH', 'Process') -split ';')) { if (-not [string]::IsNullOrWhiteSpace($e)) { [void]$pathEntries.Add($e) } }
    $cands = @()
    foreach ($b in @([Environment]::GetEnvironmentVariable('ProgramFiles'), [Environment]::GetEnvironmentVariable('ProgramFiles(x86)'), 'C:\Program Files', 'C:\Program Files (x86)')) {
      if (-not [string]::IsNullOrWhiteSpace($b)) { $cands += (Join-Path $b 'nodejs') }
    }
    $npmBases = @($env:APPDATA, 'C:\Users\Administrator\AppData\Roaming')
    if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) { $npmBases += (Join-Path $env:USERPROFILE 'AppData\Roaming') }
    foreach ($b in $npmBases) { if (-not [string]::IsNullOrWhiteSpace($b)) { $cands += (Join-Path $b 'npm') } }
    $sr = if ([string]::IsNullOrWhiteSpace($env:SystemRoot)) { 'C:\Windows' } else { $env:SystemRoot }
    $cands += @((Join-Path $sr 'System32'), $sr)
    foreach ($cand in ($cands | Select-Object -Unique)) {
      if ([string]::IsNullOrWhiteSpace($cand) -or -not (Test-Path -LiteralPath $cand)) { continue }
      $present = $false
      foreach ($e in $pathEntries) { if ($e.TrimEnd('\') -ieq $cand.TrimEnd('\')) { $present = $true; break } }
      if (-not $present) { $pathEntries.Insert(0, $cand) }
    }
    foreach ($e in $pathEntries) {
      $try = Join-Path $e.Trim().Trim('"') 'pm2.cmd'
      if (Test-Path -LiteralPath $try -PathType Leaf) { $pm2Kind = 'path'; $pm2Path = $try; break }
    }
  }

  if (-not $daemonAlive) { $resultLine = 'no_daemon' }
  elseif ($daemonOwner -eq 'unknown') { $resultLine = 'owner_unreadable' }
  elseif ($daemonOwner -ne 'true') { $resultLine = 'daemon_not_owned' }
  elseif ($null -eq $pm2Path) { $resultLine = 'pm2_not_found' }
  elseif ($PSBoundParameters.ContainsKey('ExpectedPm2Command') -and
      (Get-Item -LiteralPath $pm2Path).FullName -ine (Get-Item -LiteralPath $ExpectedPm2Command).FullName) {
    $resultLine = 'pm2_command_mismatch'
  }
  else {
    $readState = 'failed'
    $parserOk = $true
    try { Add-Type -AssemblyName System.Web.Extensions } catch { $parserOk = $false }
    if (-not $parserOk) { $resultLine = 'parser_unavailable' }
    else {
      $psi = New-Object System.Diagnostics.ProcessStartInfo
      $psi.FileName = if ([string]::IsNullOrWhiteSpace($env:ComSpec)) { 'cmd.exe' } else { $env:ComSpec }
      $psi.Arguments = '/d /s /c ""' + $pm2Path + '" jlist"'
      $psi.UseShellExecute = $false
      $psi.CreateNoWindow = $true
      $psi.RedirectStandardOutput = $true
      $psi.RedirectStandardError = $true
      $psi.RedirectStandardInput = $true
      $psi.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
      $psi.StandardErrorEncoding = New-Object System.Text.UTF8Encoding($false)
      $proc = [System.Diagnostics.Process]::Start($psi)
      $proc.StandardInput.Close()
      $outTask = $proc.StandardOutput.ReadToEndAsync()
      $errTask = $proc.StandardError.ReadToEndAsync()
      if (-not $proc.WaitForExit($TimeoutSeconds * 1000)) {
        try { $proc.Kill() } catch { }
        $resultLine = 'pm2_timeout'
      } else {
        $proc.WaitForExit()
        $text = $outTask.Result
        $null = $errTask.Result
        if ($proc.ExitCode -ne 0) { $resultLine = 'pm2_failed' }
        else {
          if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
          $m = [regex]::Match($text, '(?m)^[ \t]*\[[ \t\r\n]*[\{\]]')
          $end = $text.LastIndexOf(']')
          $parsed = $null
          if ($m.Success -and $end -gt $m.Index) {
            try {
              $ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
              $ser.MaxJsonLength = [int]::MaxValue
              $ser.RecursionLimit = 512
              $parsed = $ser.DeserializeObject($text.Substring($m.Index, $end - $m.Index + 1))
            } catch { $parsed = $null }
          }
          $text = $null
          if ($null -eq $parsed -or -not ($parsed -is [System.Array])) { $resultLine = 'parse_failed' }
          else {
            $hits = @()
            $namespaceCollision = $false
            foreach ($a in $parsed) {
              if ($a -is [System.Collections.IDictionary] -and $a.ContainsKey('name') -and ([string]$a['name']) -ceq $AppName) { $hits += , $a }
              if ($PSBoundParameters.ContainsKey('ExpectedPm2Command') -and $a -is [System.Collections.IDictionary] -and
                  $a['pm2_env'] -is [System.Collections.IDictionary] -and $a['pm2_env']['namespace'] -ceq $AppName) {
                $namespaceCollision = $true
              }
            }
            $appMatches = [string]$hits.Count
            if ($hits.Count -ne 1 -or $namespaceCollision) { $resultLine = 'app_count' }
            elseif (-not ($hits[0].ContainsKey('pm2_env') -and $hits[0]['pm2_env'] -is [System.Collections.IDictionary])) { $resultLine = 'parse_failed' }
            else {
              # canary: every Windows process has PATH. If neither bag carries it, the env is not where this
              # script looks (a pm2 version with another shape): answer incomplete, never "absent".
              $cand = $hits[0]['pm2_env']
              $visible = $false
              $cb = @(); $cb += , $cand
              if ($cand.ContainsKey('env') -and $cand['env'] -is [System.Collections.IDictionary]) { $cb += , $cand['env'] }
              foreach ($bag in $cb) { foreach ($bk in @($bag.Keys)) { if ([string]::Equals([string]$bk, 'PATH', [System.StringComparison]::OrdinalIgnoreCase)) { $visible = $true } } }
              if ($visible) { $pm2Env = $cand; $pm2App = $hits[0]; $readState = 'ok' } else { $resultLine = 'env_not_visible' }
              $cand = $null; $cb = $null
            }
            $parsed = $null; $hits = $null
          }
        }
      }
    }
  }
  'LIVEENV_PM2 pm2_home_set={0} daemon_alive={1} daemon_owner_is_current_user={2} pm2_cmd={3} read={4} app_matches={5}' -f (Out-Bool $homeSet), (Out-Bool $daemonAlive), $daemonOwner, $pm2Kind, $readState, $appMatches

  $bags = @()
  if ($null -ne $pm2Env) {
    $bags += , $pm2Env
    if ($pm2Env.ContainsKey('env') -and $pm2Env['env'] -is [System.Collections.IDictionary]) { $bags += , $pm2Env['env'] }
  }
  $dbProc = Get-DbUrlProcess $readState $bags $dockerMap
  'LIVEENV_DBURL_PROCESS process=' + $dbProc
  if ($PSBoundParameters.ContainsKey('ExpectedPm2Command')) {
    $target = 'unconfirmed'
    if ($readState -eq 'ok' -and (Get-BackendGeneration $pm2App ([DateTimeOffset]::MinValue)) -eq 'fresh') {
      $cwd = [string]$pm2App['pm2_env']['pm_cwd']
      if ([IO.Path]::IsPathRooted($cwd) -and
          (Get-Item -LiteralPath $cwd).FullName -ieq (Get-Item -LiteralPath $InstallRoot).FullName) {
        $target = 'verified'
      }
    }
    'LIVEENV_BACKEND target=' + $target
    if ($target -ne 'verified' -and $null -eq $resultLine) { $resultLine = 'backend_target_unconfirmed' }
  }
  if ($PSBoundParameters.ContainsKey('StartedAfterUtc')) {
    $after = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParseExact($StartedAfterUtc, 'o', [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::None, [ref]$after) -or $after.Offset -ne [TimeSpan]::Zero) {
      $resultLine = 'invalid_start_cutoff'
    } else {
      $generation = Get-BackendGeneration $pm2App $after
      'LIVEENV_BACKEND generation=' + $generation
      if ($generation -ne 'fresh' -and $null -eq $resultLine) { $resultLine = 'backend_generation_unconfirmed' }
    }
  }

  $gateCount = @{ 'off' = 0; 'on' = 0; 'review' = 0; 'unknown' = 0; 'record' = 0 }
  foreach ($name in $keyList) {
    $kspec = Get-KeySpec $name
    $kind = $kspec[0]; $gate = $kspec[1]
    $vg = if ($gate -eq 'record') { 'unlisted' } else { $gate }
    # files: every line counts (first line wins in the ecosystem loader, last line in the imports), so
    # show the line with the worst verdict for this key's gate, then the higher rank
    $states = @{}
    $dup = 'none'
    foreach ($which in @('root', 'docker')) {
      $map = if ($which -eq 'root') { $rootMap } else { $dockerMap }
      $fs = 'absent'
      if ($null -ne $map -and $map.ContainsKey($name)) {
        $vals = $map[$name]
        $fstates = @($vals | ForEach-Object { Get-State $_ $name })
        $fs = $fstates[0]
        foreach ($f in $fstates) {
          $vf = $VRank[(Get-Verdict $f $vg)]; $vp = $VRank[(Get-Verdict $fs $vg)]
          if ($vf -gt $vp -or ($vf -eq $vp -and $Rank[$f] -gt $Rank[$fs])) { $fs = $f }
        }
        if ($vals.Count -gt 1) {
          $distinct = @($fstates | Sort-Object -Unique)
          if ($distinct.Count -gt 1) { $dup = 'differs' } elseif ($dup -eq 'none') { $dup = 'same' }
        }
      }
      $states[$which] = $fs
    }
    # process
    $pstate = 'unknown'
    $pdup = 'none'
    if ($readState -eq 'ok') {
      $found = @()
      foreach ($bag in $bags) {
        foreach ($bk in @($bag.Keys)) {
          if ([string]::Equals([string]$bk, $name, [System.StringComparison]::OrdinalIgnoreCase)) {
            $found += (Get-State (Convert-EnvValue $bag[$bk]) $name)
          }
        }
      }
      if ($found.Count -eq 0) { $pstate = 'absent' }
      else {
        # several occurrences: show the one with the worst verdict for this key's gate, then the higher rank
        $pstate = $found[0]
        foreach ($f in $found) {
          $vf = $VRank[(Get-Verdict $f $vg)]; $vp = $VRank[(Get-Verdict $pstate $vg)]
          if ($vf -gt $vp -or ($vf -eq $vp -and $Rank[$f] -gt $Rank[$pstate])) { $pstate = $f }
        }
        if ($found.Count -gt 1) { if (@($found | Sort-Object -Unique).Count -gt 1) { $pdup = 'differs' } else { $pdup = 'same' } }
      }
    }
    $mach = Get-State ([Environment]::GetEnvironmentVariable($name, 'Machine')) $name
    $usr = Get-State ([Environment]::GetEnvironmentVariable($name, 'User')) $name
    $launch = Get-State ([Environment]::GetEnvironmentVariable($name, 'Process')) $name
    if ($gate -eq 'record') { $verdict = '-'; $gateCount['record']++ }
    else {
      $verdict = 'off'
      foreach ($st in @($pstate, $launch, $states['root'], $states['docker'])) { $verdict = Get-WorseVerdict $verdict (Get-Verdict $st $gate) }
      foreach ($st in @($mach, $usr)) {
        $v = Get-Verdict $st $gate
        if ($st -ne 'absent') { $v = Get-WorseVerdict $v 'review' }
        $verdict = Get-WorseVerdict $verdict $v
      }
      $gateCount[$verdict]++
    }
    'LIVEENV key={0} process={1} launch={2} root={3} docker={4} machine={5} user={6} dup={7} pdup={8} kind={9} gate={10} verdict={11}' -f $name, $pstate, $launch, $states['root'], $states['docker'], $mach, $usr, $dup, $pdup, $kind, $gate, $verdict
  }
  $pm2Env = $null; $bags = $null
  # root and docker DATABASE_URL differ: migrate and the backend may use two databases; the owner decides
  if ($dbRel -eq 'differs') { $gateCount['review'] += 1 }
  # the running backend's DATABASE_URL differs from docker\app.env's: step 20 moves it; the owner decides
  if ($dbProc -eq 'differs') { $gateCount['review'] += 1 }
  'LIVEENV_GATE on={0} review={1} unknown={2} off={3} record={4}' -f $gateCount['on'], $gateCount['review'], $gateCount['unknown'], $gateCount['off'], $gateCount['record']

  if ($null -eq $resultLine) {
    'LIVEENV_RESULT keys=' + $keyList.Count + ' status=complete'
    exit 0
  }
  'LIVEENV_RESULT keys=' + $keyList.Count + ' status=incomplete reason=' + $resultLine
  exit 2
} catch {
  'LIVEENV_RESULT keys=' + $keyList.Count + ' status=incomplete reason=read_error'
  exit 3
}
