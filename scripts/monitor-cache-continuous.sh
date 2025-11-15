#!/bin/bash
##
# Continuous Cache Monitoring Script
#
# Purpose: Run cache metrics collection continuously at specified intervals
# Usage: bash scripts/monitor-cache-continuous.sh [interval_hours] [output_dir]
#
# Arguments:
#   interval_hours - How often to collect (default: 24)
#   output_dir - Where to save reports (default: ./cache-reports)
#
# Example for Phase 2 deployment:
#   # Run daily collection for 2 weeks
#   bash scripts/monitor-cache-continuous.sh 24 ./cache-reports &
#
#   # Check status
#   tail -f cache-reports/monitoring.log
##

set -e

INTERVAL_HOURS="${1:-24}"
OUTPUT_DIR="${2:-./cache-reports}"
LOG_FILE="$OUTPUT_DIR/monitoring.log"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COLLECTION_SCRIPT="$SCRIPT_DIR/collect-cache-metrics.sh"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Create output directory
mkdir -p "$OUTPUT_DIR"

echo "🔄 Continuous Cache Monitoring Started"
echo "======================================"
echo ""
echo "📊 Configuration:"
echo "  Collection Interval: ${INTERVAL_HOURS}h"
echo "  Output Directory: $OUTPUT_DIR"
echo "  Log File: $LOG_FILE"
echo ""
echo "💡 To stop monitoring: kill $$ or press Ctrl+C"
echo ""

# Log function
log() {
  local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
  echo "[$timestamp] $1" | tee -a "$LOG_FILE"
}

# Trap SIGINT and SIGTERM
trap 'log "Monitoring stopped"; exit 0' SIGINT SIGTERM

log "Monitoring started (PID: $$)"

# Initial collection
log "Running initial collection..."
if bash "$COLLECTION_SCRIPT" "$INTERVAL_HOURS" "$OUTPUT_DIR" 2>&1 | tee -a "$LOG_FILE"; then
  log "Initial collection completed successfully"
else
  log "WARNING: Initial collection failed (exit code: $?)"
fi

# Continuous collection loop
iteration=1
while true; do
  # Sleep for interval
  sleep_seconds=$((INTERVAL_HOURS * 3600))
  log "Sleeping for ${INTERVAL_HOURS}h until next collection..."
  sleep "$sleep_seconds"

  # Run collection
  ((iteration++))
  log "Running collection #$iteration..."

  if bash "$COLLECTION_SCRIPT" "$INTERVAL_HOURS" "$OUTPUT_DIR" 2>&1 | tee -a "$LOG_FILE"; then
    log "Collection #$iteration completed successfully"

    # Generate trend analysis every 7 days (script not yet implemented)
    # if [ $((iteration % 7)) -eq 0 ]; then
    #   log "Generating weekly trend analysis..."
    #   bash "$SCRIPT_DIR/analyze-cache-trends.sh" "$OUTPUT_DIR" 2>&1 | tee -a "$LOG_FILE" || true
    # fi
  else
    log "WARNING: Collection #$iteration failed (exit code: $?)"
  fi
done
