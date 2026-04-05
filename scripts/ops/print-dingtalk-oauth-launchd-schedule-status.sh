#!/usr/bin/env bash
set -euo pipefail

AGENT_DIR="${AGENT_DIR:-${HOME}/Library/LaunchAgents}"
LOG_ROOT="${LOG_ROOT:-${HOME}/Library/Logs/metasheet2/dingtalk-oauth}"
USER_ID="$(id -u)"

STABILITY_LABEL="com.zensgit.metasheet.dingtalk-oauth-stability"
DRILL_LABEL="com.zensgit.metasheet.dingtalk-oauth-drill"
SUMMARY_LABEL="com.zensgit.metasheet.dingtalk-oauth-summary"
INDEX_FILE="${LOG_ROOT}/index.jsonl"

function print_agent() {
  local label="$1"
  echo "### ${label}"
  if launchctl print "gui/${USER_ID}/${label}" >/tmp/"${label}".launchd 2>/dev/null; then
    rg -n "state =|path =|last exit code =|runs =|program =|StartInterval|descriptor =|Hour|Minute" /tmp/"${label}".launchd || cat /tmp/"${label}".launchd
  else
    echo "not-loaded"
  fi
  rm -f /tmp/"${label}".launchd
}

echo "agent_dir=${AGENT_DIR}"
echo "log_root=${LOG_ROOT}"
echo "stability_plist=$([[ -f "${AGENT_DIR}/${STABILITY_LABEL}.plist" ]] && echo present || echo missing)"
echo "drill_plist=$([[ -f "${AGENT_DIR}/${DRILL_LABEL}.plist" ]] && echo present || echo missing)"
echo "summary_plist=$([[ -f "${AGENT_DIR}/${SUMMARY_LABEL}.plist" ]] && echo present || echo missing)"
echo "---"
print_agent "${STABILITY_LABEL}"
echo "---"
print_agent "${DRILL_LABEL}"
echo "---"
print_agent "${SUMMARY_LABEL}"
echo "---"
echo "recent_runs:"
if [[ -f "${INDEX_FILE}" ]]; then
  tail -n 10 "${INDEX_FILE}"
else
  echo "none"
fi
