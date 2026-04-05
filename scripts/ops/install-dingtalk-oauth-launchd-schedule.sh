#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
AGENT_DIR="${AGENT_DIR:-${HOME}/Library/LaunchAgents}"
LOG_ROOT="${LOG_ROOT:-${HOME}/Library/Logs/metasheet2/dingtalk-oauth}"
STABILITY_INTERVAL_SECONDS="${STABILITY_INTERVAL_SECONDS:-7200}"
WINDOW_INTERVAL_SECONDS="${WINDOW_INTERVAL_SECONDS:-600}"
DRILL_HOUR="${DRILL_HOUR:-20}"
DRILL_MINUTE="${DRILL_MINUTE:-0}"
SUMMARY_HOUR="${SUMMARY_HOUR:-20}"
SUMMARY_MINUTE="${SUMMARY_MINUTE:-5}"
RUN_AT_LOAD="${RUN_AT_LOAD:-true}"
USER_ID="$(id -u)"

STABILITY_LABEL="com.zensgit.metasheet.dingtalk-oauth-stability"
DRILL_LABEL="com.zensgit.metasheet.dingtalk-oauth-drill"
SUMMARY_LABEL="com.zensgit.metasheet.dingtalk-oauth-summary"
STABILITY_PLIST="${AGENT_DIR}/${STABILITY_LABEL}.plist"
DRILL_PLIST="${AGENT_DIR}/${DRILL_LABEL}.plist"
SUMMARY_PLIST="${AGENT_DIR}/${SUMMARY_LABEL}.plist"

function info() {
  echo "[install-dingtalk-oauth-launchd-schedule] $*" >&2
}

function write_stability_plist() {
  cat > "${STABILITY_PLIST}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${STABILITY_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${ROOT_DIR}/scripts/ops/dingtalk-oauth-schedule-run.sh</string>
    <string>stability</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${ROOT_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key>
    <string>${HOME}</string>
    <key>LOG_ROOT</key>
    <string>${LOG_ROOT}</string>
  </dict>
  <key>StartInterval</key>
  <integer>${STABILITY_INTERVAL_SECONDS}</integer>
  <key>RunAtLoad</key>
  <$( [[ "${RUN_AT_LOAD}" == "true" ]] && echo true || echo false )/>
  <key>StandardOutPath</key>
  <string>${LOG_ROOT}/launchd-stability.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_ROOT}/launchd-stability.stderr.log</string>
</dict>
</plist>
EOF
}

function write_drill_plist() {
  cat > "${DRILL_PLIST}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${DRILL_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${ROOT_DIR}/scripts/ops/dingtalk-oauth-schedule-window.sh</string>
    <string>drill</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${ROOT_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key>
    <string>${HOME}</string>
    <key>LOG_ROOT</key>
    <string>${LOG_ROOT}</string>
    <key>DRILL_HOUR</key>
    <string>${DRILL_HOUR}</string>
    <key>DRILL_MINUTE</key>
    <string>${DRILL_MINUTE}</string>
    <key>SUMMARY_HOUR</key>
    <string>${SUMMARY_HOUR}</string>
    <key>SUMMARY_MINUTE</key>
    <string>${SUMMARY_MINUTE}</string>
  </dict>
  <key>StartInterval</key>
  <integer>${WINDOW_INTERVAL_SECONDS}</integer>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${DRILL_HOUR}</integer>
    <key>Minute</key>
    <integer>${DRILL_MINUTE}</integer>
  </dict>
  <key>RunAtLoad</key>
  <$( [[ "${RUN_AT_LOAD}" == "true" ]] && echo true || echo false )/>
  <key>StandardOutPath</key>
  <string>${LOG_ROOT}/launchd-drill.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_ROOT}/launchd-drill.stderr.log</string>
</dict>
</plist>
EOF
}

function write_summary_plist() {
  cat > "${SUMMARY_PLIST}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SUMMARY_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${ROOT_DIR}/scripts/ops/dingtalk-oauth-schedule-window.sh</string>
    <string>summary</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${ROOT_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key>
    <string>${HOME}</string>
    <key>LOG_ROOT</key>
    <string>${LOG_ROOT}</string>
    <key>DRILL_HOUR</key>
    <string>${DRILL_HOUR}</string>
    <key>DRILL_MINUTE</key>
    <string>${DRILL_MINUTE}</string>
    <key>SUMMARY_HOUR</key>
    <string>${SUMMARY_HOUR}</string>
    <key>SUMMARY_MINUTE</key>
    <string>${SUMMARY_MINUTE}</string>
  </dict>
  <key>StartInterval</key>
  <integer>${WINDOW_INTERVAL_SECONDS}</integer>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${SUMMARY_HOUR}</integer>
    <key>Minute</key>
    <integer>${SUMMARY_MINUTE}</integer>
  </dict>
  <key>RunAtLoad</key>
  <$( [[ "${RUN_AT_LOAD}" == "true" ]] && echo true || echo false )/>
  <key>StandardOutPath</key>
  <string>${LOG_ROOT}/launchd-summary.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_ROOT}/launchd-summary.stderr.log</string>
</dict>
</plist>
EOF
}

function reload_agent() {
  local plist="$1"
  launchctl bootout "gui/${USER_ID}" "${plist}" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/${USER_ID}" "${plist}"
}

mkdir -p "${AGENT_DIR}" "${LOG_ROOT}" "${LOG_ROOT}/runs"

write_stability_plist
write_drill_plist
write_summary_plist
reload_agent "${STABILITY_PLIST}"
reload_agent "${DRILL_PLIST}"
reload_agent "${SUMMARY_PLIST}"

info "Installed ${STABILITY_PLIST}"
info "Installed ${DRILL_PLIST}"
info "Installed ${SUMMARY_PLIST}"
info "Log root: ${LOG_ROOT}"
info "Stability interval: ${STABILITY_INTERVAL_SECONDS}s"
info "Window interval: ${WINDOW_INTERVAL_SECONDS}s"
info "Drill schedule: ${DRILL_HOUR}:$(printf '%02d' "${DRILL_MINUTE}")"
info "Summary schedule: ${SUMMARY_HOUR}:$(printf '%02d' "${SUMMARY_MINUTE}")"

launchctl print "gui/${USER_ID}/${STABILITY_LABEL}" >/dev/null
launchctl print "gui/${USER_ID}/${DRILL_LABEL}" >/dev/null
launchctl print "gui/${USER_ID}/${SUMMARY_LABEL}" >/dev/null

echo "stability_plist=${STABILITY_PLIST}"
echo "drill_plist=${DRILL_PLIST}"
echo "summary_plist=${SUMMARY_PLIST}"
echo "log_root=${LOG_ROOT}"
