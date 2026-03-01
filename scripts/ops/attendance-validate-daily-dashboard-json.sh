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
escalation_mode="$(jq -r '.escalationIssue.mode // empty' "$report_json")"
p0_status="$(jq -r '.p0Status // empty' "$report_json")"
overall_status="$(jq -r '.overallStatus // empty' "$report_json")"
escalation_p0_status="$(jq -r '.escalationIssue.p0Status // empty' "$report_json")"
strict_conclusion="$(jq -r '.gates.strict.completed.conclusion // empty' "$report_json")"
strict_summary_present="$(jq -r 'if (.gateFlat.strict | type == "object" and has("summaryPresent")) then (.gateFlat.strict.summaryPresent | tostring) else "" end' "$report_json")"
strict_summary_valid="$(jq -r 'if (.gateFlat.strict | type == "object" and has("summaryValid")) then (.gateFlat.strict.summaryValid | tostring) else "" end' "$report_json")"

if [[ -z "$schema_version" ]] || ! [[ "$schema_version" =~ ^[0-9]+$ ]] || (( schema_version < 2 )); then
  die "invalid gateFlat.schemaVersion=${schema_version:-<empty>} (expected integer >= 2)"
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

perf_status="$(jq -r '.gateFlat.perf.status // empty' "$report_json")"
longrun_status="$(jq -r '.gateFlat.longrun.status // empty' "$report_json")"
perf_schema="$(jq -r '.gateFlat.perf.summarySchemaVersion // empty' "$report_json")"
longrun_schema="$(jq -r '.gateFlat.longrun.summarySchemaVersion // empty' "$report_json")"

info "OK: schemaVersion=$schema_version p0Status=$p0_status overallStatus=$overall_status mode=$escalation_mode strictConclusion=${strict_conclusion:-<empty>} strictSummaryPresent=${strict_summary_present:-<empty>} strictSummaryValid=${strict_summary_valid:-<empty>} perfStatus=${perf_status:-<empty>} perfSchema=${perf_schema:-<empty>} longrunStatus=${longrun_status:-<empty>} longrunSchema=${longrun_schema:-<empty>}"
