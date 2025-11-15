#!/bin/bash
# Phase 3 checkpoint helper: print a concise health summary
# Usage:
#   bash scripts/phase3-checkpoint.sh [LAST_N_SAMPLES]
# Defaults: LAST_N_SAMPLES=5

set -euo pipefail

ARTIFACTS_DIR="artifacts"
CSV_FILE="$ARTIFACTS_DIR/observability-24h.csv"
SUMMARY_FILE="$ARTIFACTS_DIR/observability-24h-summary.json"
LAST_N=${1:-5}

if [ ! -f "$SUMMARY_FILE" ]; then
  echo "ERROR: Summary file not found: $SUMMARY_FILE" >&2
  exit 1
fi
if [ ! -f "$CSV_FILE" ]; then
  echo "ERROR: CSV file not found: $CSV_FILE" >&2
  exit 1
fi

# Extract summary fields
SAMPLES_COLLECTED=$(jq -r '.samples_collected // 0' "$SUMMARY_FILE")
MAX_SAMPLES=$(jq -r '.max_samples // 48' "$SUMMARY_FILE")
LAST_STATUS=$(jq -r '.last_status // .status // "unknown"' "$SUMMARY_FILE")
ALERTS_LEN=$(jq -r '(.alerts | length) // 0' "$SUMMARY_FILE")

echo "=== Phase 3 Checkpoint Summary ==="
echo "Samples: ${SAMPLES_COLLECTED}/${MAX_SAMPLES}"
echo "Last Status: ${LAST_STATUS}"
echo "Alerts Count: ${ALERTS_LEN}"

# Parse last row metrics from CSV (skip header)
LAST_ROW=$(awk -F',' 'NR>1{line=$0} END{print line}' "$CSV_FILE" || true)
if [ -n "${LAST_ROW}" ]; then
  IFS=',' read -r TS SAMPLE RUNID ASUCC ACONF PFALL P99 DBP99 RATE FRATIO CSTATUS CALERTS <<< "$LAST_ROW"
  # Strip possible quotes around alert flags
  CALERTS=$(printf '%s' "$CALERTS" | sed -e 's/^"//' -e 's/"$//')

  # Determine data source
  if [ "$RUNID" = "prom" ]; then
    DSRC="Production Prometheus"
  else
    DSRC="CI run ${RUNID}"
  fi

  echo "--- Last Sample Metrics ---"
  echo "Timestamp: ${TS} (Sample #${SAMPLE})"
  echo "Data Source: ${DSRC}"
  echo "Success Rate: ${RATE} (target: ≥0.98)"
  echo "Conflicts: ${ACONF} (target: 0)"
  echo "Fallback Ratio: ${FRATIO} (target: <0.10)"
  echo "P99 Latency: ${P99}s (target: <0.30s)"
  echo "Row Status: ${CSTATUS}"
  if [ -n "${CALERTS}" ]; then
    echo "Alert Flags: ${CALERTS}"
  fi
fi

# Consecutive alerts count
CONSEC=$(grep -c "consecutive" "$CSV_FILE" 2>/dev/null || echo 0)
echo "Consecutive Alerts Found: ${CONSEC}"

echo "--- Recent ${LAST_N} Samples ---"
HEAD_OUT=$(head -n 1 "$CSV_FILE")
TAIL_OUT=$(tail -n "$LAST_N" "$CSV_FILE")
if command -v column >/dev/null 2>&1; then
  printf "%s\n%s\n" "$HEAD_OUT" "$TAIL_OUT" | column -t -s,
else
  printf "%s\n%s\n" "$HEAD_OUT" "$TAIL_OUT"
fi

exit 0
