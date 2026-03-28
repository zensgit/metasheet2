#!/usr/bin/env bash
set -euo pipefail

report_json="${1:-}"

function die() {
  echo "[attendance-validate-daily-dashboard-json] ERROR: $*" >&2
  exit 1
}

function info() {
  echo "[attendance-validate-daily-dashboard-json] $*" >&2
}

[[ -n "$report_json" ]] || die "usage: $0 <attendance-daily-gate-dashboard.json>"
[[ -f "$report_json" ]] || die "file not found: $report_json"
command -v jq >/dev/null 2>&1 || die "jq is required"

schema_version="$(jq -r '.gateFlat.schemaVersion // empty' "$report_json")"
escalation_present="$(jq -r 'has("escalationIssue") | tostring' "$report_json")"
escalation_mode="$(jq -r '.escalationIssue.mode // empty' "$report_json")"
p0_status="$(jq -r '.p0Status // empty' "$report_json")"
overall_status="$(jq -r '.overallStatus // empty' "$report_json")"
escalation_p0_status="$(jq -r '.escalationIssue.p0Status // empty' "$report_json")"
strict_conclusion="$(jq -r '.gates.strict.completed.conclusion // empty' "$report_json")"
strict_summary_present="$(jq -r 'if (.gateFlat.strict | type == "object" and has("summaryPresent")) then (.gateFlat.strict.summaryPresent | tostring) else "" end' "$report_json")"
strict_summary_valid="$(jq -r 'if (.gateFlat.strict | type == "object" and has("summaryValid")) then (.gateFlat.strict.summaryValid | tostring) else "" end' "$report_json")"

if [[ -z "$schema_version" ]] || ! [[ "$schema_version" =~ ^[0-9]+$ ]] || (( schema_version < 3 )); then
  die "invalid gateFlat.schemaVersion=${schema_version:-<empty>} (expected integer >= 3)"
fi

case "$p0_status" in
  pass|fail)
    ;;
  *)
    die "invalid p0Status=${p0_status:-<empty>} (expected pass|fail)"
    ;;
esac

case "$overall_status" in
  pass|fail)
    ;;
  *)
    die "invalid overallStatus=${overall_status:-<empty>} (expected pass|fail)"
    ;;
esac

if [[ "$escalation_present" == "true" ]]; then
  case "$escalation_mode" in
    none_or_closed|suppressed_strict_only|open|unknown)
      ;;
    *)
      die "invalid escalationIssue.mode=${escalation_mode:-<empty>}"
      ;;
  esac

  if [[ -z "$escalation_p0_status" || "$escalation_p0_status" != "$p0_status" ]]; then
    die "p0Status mismatch: p0Status=${p0_status:-<empty>} escalationIssue.p0Status=${escalation_p0_status:-<empty>}"
  fi
fi

if [[ "$strict_conclusion" == "success" && "$strict_summary_present" != "true" ]]; then
  die "strict summary contract failed: strict conclusion=success but gateFlat.strict.summaryPresent=${strict_summary_present:-<empty>}"
fi

if [[ "$strict_conclusion" == "success" && "$strict_summary_valid" != "true" ]]; then
  die "strict summary contract failed: strict conclusion=success but gateFlat.strict.summaryValid=${strict_summary_valid:-<empty>}"
fi

function validate_perf_like_gate() {
  local gate_key="$1"
  local gate_label="$2"

  local gate_object_exists
  local gate_status
  local gate_reason_code
  local gate_run_id
  local gate_completed_run_id
  local gate_summary_schema_version
  local gate_scenario
  local gate_rows
  local gate_mode
  local gate_upload_csv
  local gate_upsert_strategy
  local gate_expected_upsert_strategy
  local gate_regressions_count
  local gate_preview_ms

  gate_object_exists="$(jq -r --arg gate "$gate_key" 'if (.gateFlat[$gate] | type == "object") then "true" else "false" end' "$report_json")"
  [[ "$gate_object_exists" == "true" ]] || die "${gate_label} contract failed: gateFlat.${gate_key} is missing"

  gate_status="$(jq -r --arg gate "$gate_key" '.gateFlat[$gate].status // empty' "$report_json")"
  case "$gate_status" in
    PASS|FAIL)
      ;;
    *)
      die "${gate_label} contract failed: invalid gateFlat.${gate_key}.status=${gate_status:-<empty>} (expected PASS|FAIL)"
      ;;
  esac

  gate_reason_code="$(jq -r --arg gate "$gate_key" '.gateFlat[$gate] | if type == "object" and has("reasonCode") and .reasonCode != null then (.reasonCode | tostring) else "" end' "$report_json")"
  gate_run_id="$(jq -r --arg gate "$gate_key" '.gateFlat[$gate] | if type == "object" and has("runId") and .runId != null then (.runId | tostring) else "" end' "$report_json")"
  gate_completed_run_id="$(jq -r --arg gate "$gate_key" '.gates[$gate].completed | if type == "object" and has("id") and .id != null then (.id | tostring) else "" end' "$report_json")"

  if [[ -n "$gate_run_id" && -n "$gate_completed_run_id" && "$gate_run_id" != "$gate_completed_run_id" ]]; then
    die "${gate_label} contract failed: gateFlat.${gate_key}.runId=${gate_run_id} mismatches gates.${gate_key}.completed.id=${gate_completed_run_id}"
  fi

  if [[ "$gate_status" == "FAIL" && -z "$gate_reason_code" ]]; then
    die "${gate_label} contract failed: gateFlat.${gate_key}.status=FAIL requires non-empty reasonCode"
  fi

  if [[ "$gate_status" != "PASS" ]]; then
    return 0
  fi

  gate_summary_schema_version="$(jq -r --arg gate "$gate_key" '.gateFlat[$gate].summarySchemaVersion // empty' "$report_json")"
  gate_scenario="$(jq -r --arg gate "$gate_key" '.gateFlat[$gate].scenario // empty' "$report_json")"
  gate_rows="$(jq -r --arg gate "$gate_key" '.gateFlat[$gate].rows // empty' "$report_json")"
  gate_mode="$(jq -r --arg gate "$gate_key" '.gateFlat[$gate].mode // empty' "$report_json")"
  gate_upload_csv="$(jq -r --arg gate "$gate_key" '.gateFlat[$gate].uploadCsv // empty' "$report_json")"
  gate_upsert_strategy="$(jq -r --arg gate "$gate_key" '.gateFlat[$gate].recordUpsertStrategy // empty' "$report_json")"
  gate_expected_upsert_strategy="$(jq -r --arg gate "$gate_key" '.gateFlat[$gate].expectedRecordUpsertStrategy // empty' "$report_json")"
  gate_regressions_count="$(jq -r --arg gate "$gate_key" '.gateFlat[$gate].regressionsCount // empty' "$report_json")"
  gate_preview_ms="$(jq -r --arg gate "$gate_key" '.gateFlat[$gate].previewMs // empty' "$report_json")"

  if [[ -n "$gate_reason_code" ]]; then
    die "${gate_label} contract failed: gateFlat.${gate_key}.status=PASS but reasonCode=${gate_reason_code}"
  fi

  if [[ -z "$gate_summary_schema_version" ]] || ! [[ "$gate_summary_schema_version" =~ ^[0-9]+$ ]] || (( gate_summary_schema_version < 2 )); then
    die "${gate_label} contract failed: gateFlat.${gate_key}.summarySchemaVersion=${gate_summary_schema_version:-<empty>} (expected integer >= 2 when status=PASS)"
  fi

  [[ -n "$gate_scenario" ]] || die "${gate_label} contract failed: gateFlat.${gate_key}.scenario is empty when status=PASS"
  [[ -n "$gate_rows" && "$gate_rows" =~ ^[0-9]+$ && "$gate_rows" -gt 0 ]] || die "${gate_label} contract failed: gateFlat.${gate_key}.rows=${gate_rows:-<empty>} (expected positive integer when status=PASS)"

  case "$gate_mode" in
    preview|commit)
      ;;
    *)
      die "${gate_label} contract failed: gateFlat.${gate_key}.mode=${gate_mode:-<empty>} (expected preview|commit when status=PASS)"
      ;;
  esac

  case "$gate_upload_csv" in
    true|false)
      ;;
    *)
      die "${gate_label} contract failed: gateFlat.${gate_key}.uploadCsv=${gate_upload_csv:-<empty>} (expected true|false when status=PASS)"
      ;;
  esac

  if [[ -n "$gate_upsert_strategy" ]]; then
    case "$gate_upsert_strategy" in
      values|unnest|staging)
        ;;
      *)
        die "${gate_label} contract failed: gateFlat.${gate_key}.recordUpsertStrategy=${gate_upsert_strategy} (expected values|unnest|staging when present)"
        ;;
    esac
  fi

  if [[ -n "$gate_expected_upsert_strategy" ]]; then
    case "$gate_expected_upsert_strategy" in
      values|unnest|staging)
        ;;
      *)
        die "${gate_label} contract failed: gateFlat.${gate_key}.expectedRecordUpsertStrategy=${gate_expected_upsert_strategy} (expected values|unnest|staging when present)"
        ;;
    esac

    if [[ -z "$gate_upsert_strategy" ]]; then
      die "${gate_label} contract failed: gateFlat.${gate_key}.expectedRecordUpsertStrategy=${gate_expected_upsert_strategy} but recordUpsertStrategy is empty"
    fi
    if [[ "$gate_upsert_strategy" != "$gate_expected_upsert_strategy" ]]; then
      die "${gate_label} contract failed: gateFlat.${gate_key}.recordUpsertStrategy=${gate_upsert_strategy} mismatches expectedRecordUpsertStrategy=${gate_expected_upsert_strategy}"
    fi
  fi

  if [[ -z "$gate_regressions_count" ]] || ! [[ "$gate_regressions_count" =~ ^[0-9]+$ ]]; then
    die "${gate_label} contract failed: gateFlat.${gate_key}.regressionsCount=${gate_regressions_count:-<empty>} (expected integer when status=PASS)"
  fi

  if [[ -z "$gate_preview_ms" ]] || ! [[ "$gate_preview_ms" =~ ^[0-9]+$ ]]; then
    die "${gate_label} contract failed: gateFlat.${gate_key}.previewMs=${gate_preview_ms:-<empty>} (expected integer when status=PASS)"
  fi
}

validate_perf_like_gate "perf" "Perf Baseline"
validate_perf_like_gate "longrun" "Perf Long Run"
if [[ "$(jq -r 'if (.gateFlat.highscale | type == "object") then "true" else "false" end' "$report_json")" == "true" ]]; then
  validate_perf_like_gate "highscale" "Perf High Scale"
fi

function validate_locale_zh_gate() {
  local gate_key="localeZh"
  local gate_label="Locale zh Smoke"

  local gate_object_exists
  local gate_status
  local gate_reason_code
  local gate_run_id
  local gate_completed_run_id
  local gate_summary_schema_version
  local gate_auth_source
  local gate_lunar_label_count
  local gate_holiday_badge_count
  local gate_holiday_check_enabled
  local gate_toggle_check_skipped
  local gate_toggle_check_reason
  local gate_zh_shell_tabs_checked
  local gate_zh_overview_tab
  local gate_zh_admin_tab
  local gate_zh_workflow_tab

  gate_object_exists="$(jq -r --arg gate "$gate_key" 'if (.gateFlat[$gate] | type == "object") then "true" else "false" end' "$report_json")"
  [[ "$gate_object_exists" == "true" ]] || die "${gate_label} contract failed: gateFlat.${gate_key} is missing"

  gate_status="$(jq -r --arg gate "$gate_key" '.gateFlat[$gate].status // empty' "$report_json")"
  case "$gate_status" in
    PASS|FAIL)
      ;;
    *)
      die "${gate_label} contract failed: invalid gateFlat.${gate_key}.status=${gate_status:-<empty>} (expected PASS|FAIL)"
      ;;
  esac

  gate_reason_code="$(jq -r --arg gate "$gate_key" '.gateFlat[$gate] | if type == "object" and has("reasonCode") and .reasonCode != null then (.reasonCode | tostring) else "" end' "$report_json")"
  gate_run_id="$(jq -r --arg gate "$gate_key" '.gateFlat[$gate] | if type == "object" and has("runId") and .runId != null then (.runId | tostring) else "" end' "$report_json")"
  gate_completed_run_id="$(jq -r --arg gate "$gate_key" '.gates[$gate].completed | if type == "object" and has("id") and .id != null then (.id | tostring) else "" end' "$report_json")"

  if [[ -n "$gate_run_id" && -n "$gate_completed_run_id" && "$gate_run_id" != "$gate_completed_run_id" ]]; then
    die "${gate_label} contract failed: gateFlat.${gate_key}.runId=${gate_run_id} mismatches gates.${gate_key}.completed.id=${gate_completed_run_id}"
  fi

  if [[ "$gate_status" == "FAIL" && -z "$gate_reason_code" ]]; then
    die "${gate_label} contract failed: gateFlat.${gate_key}.status=FAIL requires non-empty reasonCode"
  fi

  if [[ "$gate_status" != "PASS" ]]; then
    return 0
  fi

  if [[ -n "$gate_reason_code" ]]; then
    die "${gate_label} contract failed: gateFlat.${gate_key}.status=PASS but reasonCode=${gate_reason_code}"
  fi

  gate_summary_schema_version="$(jq -r --arg gate "$gate_key" '.gateFlat[$gate].summarySchemaVersion // empty' "$report_json")"
  if [[ -z "$gate_summary_schema_version" ]] || ! [[ "$gate_summary_schema_version" =~ ^[0-9]+$ ]] || (( gate_summary_schema_version < 2 )); then
    die "${gate_label} contract failed: gateFlat.${gate_key}.summarySchemaVersion=${gate_summary_schema_version:-<empty>} (expected integer >= 2 when status=PASS)"
  fi

  gate_auth_source="$(jq -r --arg gate "$gate_key" '.gateFlat[$gate].authSource // empty' "$report_json")"
  if (( gate_summary_schema_version >= 3 )); then
    case "$gate_auth_source" in
      token|refresh|login|unknown)
        ;;
      *)
        die "${gate_label} contract failed: gateFlat.${gate_key}.authSource=${gate_auth_source:-<empty>} (required token|refresh|login|unknown when summarySchemaVersion>=3)"
        ;;
    esac
  elif [[ -n "$gate_auth_source" ]]; then
    case "$gate_auth_source" in
      token|refresh|login|unknown)
        ;;
      *)
        die "${gate_label} contract failed: gateFlat.${gate_key}.authSource=${gate_auth_source} (expected token|refresh|login|unknown when present)"
        ;;
    esac
  fi

  gate_lunar_label_count="$(jq -r --arg gate "$gate_key" '.gateFlat[$gate] | if has("lunarLabelCount") and .lunarLabelCount != null then (.lunarLabelCount | tostring) else "" end' "$report_json")"
  if [[ -n "$gate_lunar_label_count" && ! "$gate_lunar_label_count" =~ ^[0-9]+$ ]]; then
    die "${gate_label} contract failed: gateFlat.${gate_key}.lunarLabelCount=${gate_lunar_label_count} (expected integer when present)"
  fi

  gate_holiday_badge_count="$(jq -r --arg gate "$gate_key" '.gateFlat[$gate] | if has("holidayBadgeCount") and .holidayBadgeCount != null then (.holidayBadgeCount | tostring) else "" end' "$report_json")"
  if [[ -n "$gate_holiday_badge_count" && ! "$gate_holiday_badge_count" =~ ^[0-9]+$ ]]; then
    die "${gate_label} contract failed: gateFlat.${gate_key}.holidayBadgeCount=${gate_holiday_badge_count} (expected integer when present)"
  fi

  gate_holiday_check_enabled="$(jq -r --arg gate "$gate_key" '.gateFlat[$gate].holidayCheckEnabled // empty' "$report_json")"
  if [[ -n "$gate_holiday_check_enabled" ]]; then
    case "$gate_holiday_check_enabled" in
      true|false)
        ;;
      *)
        die "${gate_label} contract failed: gateFlat.${gate_key}.holidayCheckEnabled=${gate_holiday_check_enabled} (expected true|false when present)"
        ;;
    esac
  fi

  gate_toggle_check_skipped="$(jq -r --arg gate "$gate_key" '.gateFlat[$gate].toggleCheckSkipped // empty' "$report_json")"
  gate_toggle_check_reason="$(jq -r --arg gate "$gate_key" '.gateFlat[$gate].toggleCheckReason // empty' "$report_json")"
  if (( gate_summary_schema_version >= 2 )); then
    case "$gate_toggle_check_skipped" in
      true|false)
        ;;
      *)
        die "${gate_label} contract failed: gateFlat.${gate_key}.toggleCheckSkipped=${gate_toggle_check_skipped:-<empty>} (required true|false when summarySchemaVersion>=2)"
        ;;
    esac

    if [[ "$gate_toggle_check_skipped" == "true" && -z "$gate_toggle_check_reason" ]]; then
      die "${gate_label} contract failed: gateFlat.${gate_key}.toggleCheckReason is required when toggleCheckSkipped=true"
    fi
  elif [[ -n "$gate_toggle_check_skipped" ]]; then
    case "$gate_toggle_check_skipped" in
      true|false)
        ;;
      *)
        die "${gate_label} contract failed: gateFlat.${gate_key}.toggleCheckSkipped=${gate_toggle_check_skipped} (expected true|false when present)"
        ;;
    esac
  fi

  if (( gate_summary_schema_version >= 3 )); then
    gate_zh_shell_tabs_checked="$(jq -r --arg gate "$gate_key" '.gateFlat[$gate].zhShellTabsChecked // empty' "$report_json")"
    case "$gate_zh_shell_tabs_checked" in
      true|false)
        ;;
      *)
        die "${gate_label} contract failed: gateFlat.${gate_key}.zhShellTabsChecked=${gate_zh_shell_tabs_checked:-<empty>} (required true|false when summarySchemaVersion>=3)"
        ;;
    esac

    if [[ "$gate_zh_shell_tabs_checked" == "true" ]]; then
      gate_zh_overview_tab="$(jq -r --arg gate "$gate_key" '.gateFlat[$gate].zhOverviewTab // empty' "$report_json")"
      gate_zh_admin_tab="$(jq -r --arg gate "$gate_key" '.gateFlat[$gate].zhAdminTab // empty' "$report_json")"
      gate_zh_workflow_tab="$(jq -r --arg gate "$gate_key" '.gateFlat[$gate].zhWorkflowTab // empty' "$report_json")"
      case "$gate_zh_overview_tab" in
        true|false) ;;
        *) die "${gate_label} contract failed: gateFlat.${gate_key}.zhOverviewTab=${gate_zh_overview_tab:-<empty>} (required true|false when zhShellTabsChecked=true)" ;;
      esac
      case "$gate_zh_admin_tab" in
        true|false) ;;
        *) die "${gate_label} contract failed: gateFlat.${gate_key}.zhAdminTab=${gate_zh_admin_tab:-<empty>} (required true|false when zhShellTabsChecked=true)" ;;
      esac
      case "$gate_zh_workflow_tab" in
        true|false) ;;
        *) die "${gate_label} contract failed: gateFlat.${gate_key}.zhWorkflowTab=${gate_zh_workflow_tab:-<empty>} (required true|false when zhShellTabsChecked=true)" ;;
      esac
    fi
  fi
}

validate_locale_zh_gate

function validate_cleanup_gate() {
  local gate_key="cleanup"
  local gate_label="Upload Cleanup"

  local gate_object_exists
  local gate_status
  local gate_reason_code
  local gate_run_id
  local gate_completed_run_id
  local gate_stale_count

  gate_object_exists="$(jq -r --arg gate "$gate_key" 'if (.gateFlat[$gate] | type == "object") then "true" else "false" end' "$report_json")"
  [[ "$gate_object_exists" == "true" ]] || die "${gate_label} contract failed: gateFlat.${gate_key} is missing"

  gate_status="$(jq -r --arg gate "$gate_key" '.gateFlat[$gate].status // empty' "$report_json")"
  case "$gate_status" in
    PASS|FAIL)
      ;;
    *)
      die "${gate_label} contract failed: invalid gateFlat.${gate_key}.status=${gate_status:-<empty>} (expected PASS|FAIL)"
      ;;
  esac

  gate_reason_code="$(jq -r --arg gate "$gate_key" '.gateFlat[$gate] | if type == "object" and has("reasonCode") and .reasonCode != null then (.reasonCode | tostring) else "" end' "$report_json")"
  gate_run_id="$(jq -r --arg gate "$gate_key" '.gateFlat[$gate] | if type == "object" and has("runId") and .runId != null then (.runId | tostring) else "" end' "$report_json")"
  gate_completed_run_id="$(jq -r --arg gate "$gate_key" '.gates[$gate].completed | if type == "object" and has("id") and .id != null then (.id | tostring) else "" end' "$report_json")"

  if [[ -n "$gate_run_id" && -n "$gate_completed_run_id" && "$gate_run_id" != "$gate_completed_run_id" ]]; then
    die "${gate_label} contract failed: gateFlat.${gate_key}.runId=${gate_run_id} mismatches gates.${gate_key}.completed.id=${gate_completed_run_id}"
  fi

  if [[ "$gate_status" == "FAIL" && -z "$gate_reason_code" ]]; then
    die "${gate_label} contract failed: gateFlat.${gate_key}.status=FAIL requires non-empty reasonCode"
  fi

  if [[ "$gate_status" == "PASS" && -n "$gate_reason_code" ]]; then
    die "${gate_label} contract failed: gateFlat.${gate_key}.status=PASS but reasonCode=${gate_reason_code}"
  fi

  gate_stale_count="$(jq -r --arg gate "$gate_key" '.gateFlat[$gate] | if has("staleCount") and .staleCount != null then (.staleCount | tostring) else "" end' "$report_json")"
  if [[ -n "$gate_stale_count" && ! "$gate_stale_count" =~ ^[0-9]+$ ]]; then
    die "${gate_label} contract failed: gateFlat.${gate_key}.staleCount=${gate_stale_count} (expected integer when present)"
  fi
}

validate_cleanup_gate

function validate_remote_signal_gate() {
  local gate_key="$1"
  local gate_label="$2"

  local gate_object_exists
  local gate_status
  local gate_run_id
  local gate_completed_run_id
  local gate_signal_branch
  local gate_latest_scheduled_run_id
  local gate_latest_scheduled_conclusion
  local gate_latest_manual_run_id
  local gate_latest_manual_conclusion
  local gate_manual_recovery
  local signal_channels_exists
  local signal_scheduled_id
  local signal_scheduled_conclusion
  local signal_manual_id
  local signal_manual_conclusion
  local signal_manual_recovery

  gate_object_exists="$(jq -r --arg gate "$gate_key" 'if (.gateFlat[$gate] | type == "object") then "true" else "false" end' "$report_json")"
  [[ "$gate_object_exists" == "true" ]] || return 0

  gate_status="$(jq -r --arg gate "$gate_key" '.gateFlat[$gate].status // empty' "$report_json")"
  case "$gate_status" in
    PASS|FAIL)
      ;;
    *)
      die "${gate_label} contract failed: invalid gateFlat.${gate_key}.status=${gate_status:-<empty>} (expected PASS|FAIL)"
      ;;
  esac

  gate_run_id="$(jq -r --arg gate "$gate_key" '.gateFlat[$gate] | if has("runId") and .runId != null then (.runId | tostring) else "" end' "$report_json")"
  gate_completed_run_id="$(jq -r --arg gate "$gate_key" '.gates[$gate].completed | if type == "object" and has("id") and .id != null then (.id | tostring) else "" end' "$report_json")"
  if [[ -n "$gate_run_id" && -n "$gate_completed_run_id" && "$gate_run_id" != "$gate_completed_run_id" ]]; then
    die "${gate_label} contract failed: gateFlat.${gate_key}.runId=${gate_run_id} mismatches gates.${gate_key}.completed.id=${gate_completed_run_id}"
  fi

  gate_signal_branch="$(jq -r --arg gate "$gate_key" '.gateFlat[$gate].signalBranch // empty' "$report_json")"
  if [[ -n "$gate_signal_branch" && "$gate_signal_branch" =~ [[:space:]] ]]; then
    die "${gate_label} contract failed: gateFlat.${gate_key}.signalBranch contains whitespace"
  fi

  gate_latest_scheduled_run_id="$(jq -r --arg gate "$gate_key" '.gateFlat[$gate] | if has("latestScheduledRunId") and .latestScheduledRunId != null then (.latestScheduledRunId | tostring) else "" end' "$report_json")"
  if [[ -n "$gate_latest_scheduled_run_id" && ! "$gate_latest_scheduled_run_id" =~ ^[0-9]+$ ]]; then
    die "${gate_label} contract failed: gateFlat.${gate_key}.latestScheduledRunId=${gate_latest_scheduled_run_id} (expected integer when present)"
  fi

  gate_latest_manual_run_id="$(jq -r --arg gate "$gate_key" '.gateFlat[$gate] | if has("latestManualRunId") and .latestManualRunId != null then (.latestManualRunId | tostring) else "" end' "$report_json")"
  if [[ -n "$gate_latest_manual_run_id" && ! "$gate_latest_manual_run_id" =~ ^[0-9]+$ ]]; then
    die "${gate_label} contract failed: gateFlat.${gate_key}.latestManualRunId=${gate_latest_manual_run_id} (expected integer when present)"
  fi

  gate_latest_scheduled_conclusion="$(jq -r --arg gate "$gate_key" '.gateFlat[$gate].latestScheduledConclusion // empty' "$report_json")"
  if [[ -n "$gate_latest_scheduled_conclusion" && "$gate_latest_scheduled_conclusion" =~ [[:space:]] ]]; then
    die "${gate_label} contract failed: gateFlat.${gate_key}.latestScheduledConclusion=${gate_latest_scheduled_conclusion} (expected single token when present)"
  fi

  gate_latest_manual_conclusion="$(jq -r --arg gate "$gate_key" '.gateFlat[$gate].latestManualConclusion // empty' "$report_json")"
  if [[ -n "$gate_latest_manual_conclusion" && "$gate_latest_manual_conclusion" =~ [[:space:]] ]]; then
    die "${gate_label} contract failed: gateFlat.${gate_key}.latestManualConclusion=${gate_latest_manual_conclusion} (expected single token when present)"
  fi

  gate_manual_recovery="$(jq -r --arg gate "$gate_key" '.gateFlat[$gate] | if has("manualRecovery") and .manualRecovery != null then (.manualRecovery | tostring) else "" end' "$report_json")"
  case "$gate_manual_recovery" in
    ""|true|false)
      ;;
    *)
      die "${gate_label} contract failed: gateFlat.${gate_key}.manualRecovery=${gate_manual_recovery} (expected true|false when present)"
      ;;
  esac

  signal_channels_exists="$(jq -r --arg gate "$gate_key" 'if (.gates[$gate].signalChannels | type == "object") then "true" else "false" end' "$report_json")"
  [[ "$signal_channels_exists" == "true" ]] || return 0

  signal_scheduled_id="$(jq -r --arg gate "$gate_key" '.gates[$gate].signalChannels.latestScheduledCompleted | if type == "object" and has("id") and .id != null then (.id | tostring) else "" end' "$report_json")"
  if [[ -n "$signal_scheduled_id" && ! "$signal_scheduled_id" =~ ^[0-9]+$ ]]; then
    die "${gate_label} contract failed: gates.${gate_key}.signalChannels.latestScheduledCompleted.id=${signal_scheduled_id} (expected integer when present)"
  fi

  signal_manual_id="$(jq -r --arg gate "$gate_key" '.gates[$gate].signalChannels.latestManualCompleted | if type == "object" and has("id") and .id != null then (.id | tostring) else "" end' "$report_json")"
  if [[ -n "$signal_manual_id" && ! "$signal_manual_id" =~ ^[0-9]+$ ]]; then
    die "${gate_label} contract failed: gates.${gate_key}.signalChannels.latestManualCompleted.id=${signal_manual_id} (expected integer when present)"
  fi

  signal_scheduled_conclusion="$(jq -r --arg gate "$gate_key" '.gates[$gate].signalChannels.latestScheduledCompleted.conclusion // empty' "$report_json")"
  if [[ -n "$signal_scheduled_conclusion" && "$signal_scheduled_conclusion" =~ [[:space:]] ]]; then
    die "${gate_label} contract failed: gates.${gate_key}.signalChannels.latestScheduledCompleted.conclusion=${signal_scheduled_conclusion} (expected single token when present)"
  fi

  signal_manual_conclusion="$(jq -r --arg gate "$gate_key" '.gates[$gate].signalChannels.latestManualCompleted.conclusion // empty' "$report_json")"
  if [[ -n "$signal_manual_conclusion" && "$signal_manual_conclusion" =~ [[:space:]] ]]; then
    die "${gate_label} contract failed: gates.${gate_key}.signalChannels.latestManualCompleted.conclusion=${signal_manual_conclusion} (expected single token when present)"
  fi

  signal_manual_recovery="$(jq -r --arg gate "$gate_key" '.gates[$gate].signalChannels | if has("manualRecovery") and .manualRecovery != null then (.manualRecovery | tostring) else "" end' "$report_json")"
  case "$signal_manual_recovery" in
    true|false)
      ;;
    *)
      die "${gate_label} contract failed: gates.${gate_key}.signalChannels.manualRecovery=${signal_manual_recovery:-<empty>} (expected true|false)"
      ;;
  esac

  if [[ -n "$gate_latest_scheduled_run_id" && -n "$signal_scheduled_id" && "$gate_latest_scheduled_run_id" != "$signal_scheduled_id" ]]; then
    die "${gate_label} contract failed: gateFlat.${gate_key}.latestScheduledRunId=${gate_latest_scheduled_run_id} mismatches gates.${gate_key}.signalChannels.latestScheduledCompleted.id=${signal_scheduled_id}"
  fi

  if [[ -n "$gate_latest_manual_run_id" && -n "$signal_manual_id" && "$gate_latest_manual_run_id" != "$signal_manual_id" ]]; then
    die "${gate_label} contract failed: gateFlat.${gate_key}.latestManualRunId=${gate_latest_manual_run_id} mismatches gates.${gate_key}.signalChannels.latestManualCompleted.id=${signal_manual_id}"
  fi

  if [[ -n "$gate_latest_scheduled_conclusion" && -n "$signal_scheduled_conclusion" && "$gate_latest_scheduled_conclusion" != "$signal_scheduled_conclusion" ]]; then
    die "${gate_label} contract failed: gateFlat.${gate_key}.latestScheduledConclusion=${gate_latest_scheduled_conclusion} mismatches gates.${gate_key}.signalChannels.latestScheduledCompleted.conclusion=${signal_scheduled_conclusion}"
  fi

  if [[ -n "$gate_latest_manual_conclusion" && -n "$signal_manual_conclusion" && "$gate_latest_manual_conclusion" != "$signal_manual_conclusion" ]]; then
    die "${gate_label} contract failed: gateFlat.${gate_key}.latestManualConclusion=${gate_latest_manual_conclusion} mismatches gates.${gate_key}.signalChannels.latestManualCompleted.conclusion=${signal_manual_conclusion}"
  fi

  if [[ -n "$gate_manual_recovery" && "$gate_manual_recovery" != "$signal_manual_recovery" ]]; then
    die "${gate_label} contract failed: gateFlat.${gate_key}.manualRecovery=${gate_manual_recovery} mismatches gates.${gate_key}.signalChannels.manualRecovery=${signal_manual_recovery}"
  fi
}

validate_remote_signal_gate "preflight" "Remote Preflight"
validate_remote_signal_gate "metrics" "Host Metrics"
validate_remote_signal_gate "storage" "Storage Health"
validate_remote_signal_gate "cleanup" "Upload Cleanup"

cleanup_status="$(jq -r '.gateFlat.cleanup.status // empty' "$report_json")"
perf_status="$(jq -r '.gateFlat.perf.status // empty' "$report_json")"
longrun_status="$(jq -r '.gateFlat.longrun.status // empty' "$report_json")"
perf_schema="$(jq -r '.gateFlat.perf.summarySchemaVersion // empty' "$report_json")"
longrun_schema="$(jq -r '.gateFlat.longrun.summarySchemaVersion // empty' "$report_json")"
locale_zh_status="$(jq -r '.gateFlat.localeZh.status // empty' "$report_json")"
locale_zh_schema="$(jq -r '.gateFlat.localeZh.summarySchemaVersion // empty' "$report_json")"

escalation_mode_safe="${escalation_mode:-<empty>}"
if [[ "$escalation_present" != "true" ]]; then
  escalation_mode_safe="missing"
fi

info "OK: schemaVersion=$schema_version p0Status=$p0_status overallStatus=$overall_status mode=${escalation_mode_safe} strictConclusion=${strict_conclusion:-<empty>} strictSummaryPresent=${strict_summary_present:-<empty>} strictSummaryValid=${strict_summary_valid:-<empty>} cleanupStatus=${cleanup_status:-<empty>} perfStatus=${perf_status:-<empty>} perfSchema=${perf_schema:-<empty>} longrunStatus=${longrun_status:-<empty>} longrunSchema=${longrun_schema:-<empty>} localeZhStatus=${locale_zh_status:-<empty>} localeZhSchema=${locale_zh_schema:-<empty>}"
