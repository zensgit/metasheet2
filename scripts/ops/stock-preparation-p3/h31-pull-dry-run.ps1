# h31-pull-dry-run.ps1 - one pull preview (dry-run) for one project: the same request the daily scheduled
# pull sends (scripts\ops\stock-preparation-scheduled-pull.mjs: POST .../table-actions/<action>/dry-run
# with {"parameters": {"projectNo": "<project>"}}). Install sheet steps 31.3 and 30.5 (second form).
# It writes no sheet row; the server may keep a short-lived preview token. Windows PowerShell 5.1.
# R-P2-2: this is NOT the scheduled pull and does not trigger it.
#
# RUN (see _http.ps1 for MS_API / MS_TENANT_ID; the project number goes on the command line only):
#   powershell -NoProfile -ExecutionPolicy Bypass -File h31-pull-dry-run.ps1 -TokenFile '<token file>' -ProjectNo '<project>' -Ordinal <n>
#
# OUTPUT:
#   PULLDRY project=<n> status=<http> code=<CODE|none> result=<data.status word|none> can_apply=true|false|none field_existence_mode=db|other|none field_map_mode=explicit|other|none missing_fields=<n|none>
#   PULLDRY_COUNTS project=<n> add=<n> update=<n> skip=<n> inactive=<n> manual_confirm=<n>
#   PULLDRY_RESULT file=h31-pull-dry-run.ps1 status=complete http=<http>
# After the column repair the preview answers 200. Before it: 422 TARGET_SCHEMA_INCOMPLETE with
# field_existence_mode=db and missing_fields=2 (project sheet), or field_map_mode=explicit (env binding).
param(
  [Parameter(Mandatory = $true)][string]$TokenFile,
  [Parameter(Mandatory = $true)][string]$ProjectNo,
  [Parameter(Mandatory = $true)][int]$Ordinal
)
. (Join-Path $PSScriptRoot '_http.ps1')
. (Join-Path $PSScriptRoot '_pull-plan-counts.ps1')
try {
  if (-not (Test-ProjectNo $ProjectNo)) { 'PULLDRY_RESULT file=h31-pull-dry-run.ps1 status=incomplete reason=project_no_invalid'; exit 2 }
  $why = Initialize-Http $TokenFile
  if ($why) { 'PULLDRY_RESULT file=h31-pull-dry-run.ps1 status=incomplete reason=' + $why; exit 2 }
  $body = @{ parameters = @{ projectNo = $ProjectNo } }
  $r = Invoke-Http 'POST' '/api/integration/table-actions/plm.stock-preparation.pull-bom.v1/dry-run' $body -Integration
  if ($r.NoAnswer) { 'PULLDRY_RESULT file=h31-pull-dry-run.ps1 status=incomplete reason=' + $r.NoAnswer; exit 3 }
  $res = 'none'; $can = 'none'; $fem = 'none'; $fmm = 'none'; $mf = 'none'
  if ($r.Status -eq 200 -and $null -ne $r.Json -and $null -ne $r.Json.data) {
    $res = Get-Word $r.Json.data.status
    if ($r.Json.data.canApply -is [bool]) { $can = Get-Word $r.Json.data.canApply }
  }
  if ($null -ne $r.Json -and $null -ne $r.Json.error -and $r.Json.error -isnot [string] -and $null -ne $r.Json.error.details) {
    $d = $r.Json.error.details
    if ($null -ne $d.fieldExistenceMode) { $fem = if ([string]$d.fieldExistenceMode -ceq 'db') { 'db' } else { 'other' } }
    if ($null -ne $d.fieldMapMode) { $fmm = if ([string]$d.fieldMapMode -ceq 'explicit') { 'explicit' } else { 'other' } }
    if ($null -ne $d.missingFields) { $mf = [string]@($d.missingFields).Count }
  }
  'PULLDRY project={0} status={1} code={2} result={3} can_apply={4} field_existence_mode={5} field_map_mode={6} missing_fields={7}' -f $Ordinal, $r.Status, (Get-ErrCode $r.Json), $res, $can, $fem, $fmm, $mf
  if ($r.Status -eq 200) {
    $line = Get-PullPlanCountsLine $r.Json.data $Ordinal
    if (-not $line) { 'PULLDRY_RESULT file=h31-pull-dry-run.ps1 status=incomplete reason=invalid_counts'; exit 3 }
    $line
  }
  'PULLDRY_RESULT file=h31-pull-dry-run.ps1 status=complete http=' + $r.Status
} catch {
  'PULLDRY_RESULT file=h31-pull-dry-run.ps1 status=incomplete reason=script_error'
  exit 3
} finally { Clear-Http }
