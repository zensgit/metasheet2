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

info "OK: schemaVersion=$schema_version p0Status=$p0_status overallStatus=$overall_status mode=$escalation_mode strictConclusion=${strict_conclusion:-<empty>} strictSummaryPresent=${strict_summary_present:-<empty>} strictSummaryValid=${strict_summary_valid:-<empty>}"
