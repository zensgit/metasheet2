#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MODE="${1:-}"
LOG_ROOT="${LOG_ROOT:-${HOME}/Library/Logs/metasheet2/dingtalk-oauth}"
INDEX_FILE="${INDEX_FILE:-${LOG_ROOT}/index.jsonl}"
DRILL_HOUR="${DRILL_HOUR:-20}"
DRILL_MINUTE="${DRILL_MINUTE:-0}"
SUMMARY_HOUR="${SUMMARY_HOUR:-20}"
SUMMARY_MINUTE="${SUMMARY_MINUTE:-5}"
SCHEDULE_RUN_SCRIPT="${SCHEDULE_RUN_SCRIPT:-${ROOT_DIR}/scripts/ops/dingtalk-oauth-schedule-run.sh}"

function die() {
  echo "[dingtalk-oauth-schedule-window] ERROR: $*" >&2
  exit 1
}

[[ "${MODE}" == "drill" || "${MODE}" == "summary" ]] || die "Usage: $0 <drill|summary>"

WINDOW_OUTPUT="$(
  MODE_INPUT="${MODE}" \
  INDEX_FILE_INPUT="${INDEX_FILE}" \
  DRILL_HOUR_INPUT="${DRILL_HOUR}" \
  DRILL_MINUTE_INPUT="${DRILL_MINUTE}" \
  SUMMARY_HOUR_INPUT="${SUMMARY_HOUR}" \
  SUMMARY_MINUTE_INPUT="${SUMMARY_MINUTE}" \
  python3 - <<'PY'
import json
import os
from datetime import datetime
from pathlib import Path


def parse_checked_at(value: str):
    if not value:
        return None
    normalized = value.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(normalized).astimezone()
    except ValueError:
        return None


def latest_local_date(index_path: Path, kind: str):
    if not index_path.exists():
        return None
    latest = None
    for line in index_path.read_text(encoding="utf-8", errors="replace").splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        try:
            record = json.loads(stripped)
        except json.JSONDecodeError:
            continue
        if record.get("kind") != kind or record.get("exitCode") != 0:
            continue
        checked_at = parse_checked_at(record.get("checkedAt"))
        if checked_at is None:
            continue
        if latest is None or checked_at > latest:
            latest = checked_at
    return latest.date().isoformat() if latest is not None else None


mode = os.environ["MODE_INPUT"]
now_local = datetime.now().astimezone()
today_local = now_local.date().isoformat()
current_minutes = now_local.hour * 60 + now_local.minute

schedule_minutes = (
    int(os.environ["DRILL_HOUR_INPUT"]) * 60 + int(os.environ["DRILL_MINUTE_INPUT"])
    if mode == "drill"
    else int(os.environ["SUMMARY_HOUR_INPUT"]) * 60 + int(os.environ["SUMMARY_MINUTE_INPUT"])
)

index_path = Path(os.environ["INDEX_FILE_INPUT"])
latest_kind_date = latest_local_date(index_path, mode)
latest_drill_date = latest_local_date(index_path, "drill")

report = {
    "mode": mode,
    "nowLocal": now_local.isoformat(),
    "todayLocal": today_local,
    "currentMinutes": current_minutes,
    "scheduleMinutes": schedule_minutes,
    "latestKindDate": latest_kind_date,
    "latestDrillDate": latest_drill_date,
}

if current_minutes < schedule_minutes:
    report["action"] = "skip"
    report["reason"] = "before-window"
elif latest_kind_date == today_local:
    report["action"] = "skip"
    report["reason"] = "already-ran-today"
elif mode == "summary" and latest_drill_date != today_local:
    report["action"] = "skip"
    report["reason"] = "waiting-for-drill"
else:
    report["action"] = "run"
    report["reason"] = "window-open"

print(json.dumps(report, ensure_ascii=False))
PY
)"

ACTION="$(printf '%s' "${WINDOW_OUTPUT}" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["action"])')"
REASON="$(printf '%s' "${WINDOW_OUTPUT}" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["reason"])')"

if [[ "${ACTION}" == "skip" ]]; then
  echo "[dingtalk-oauth-schedule-window] mode=${MODE} action=skip reason=${REASON}"
  exit 0
fi

echo "[dingtalk-oauth-schedule-window] mode=${MODE} action=run reason=${REASON}"
exec /bin/bash "${SCHEDULE_RUN_SCRIPT}" "${MODE}"
