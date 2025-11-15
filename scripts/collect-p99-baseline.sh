#!/bin/bash
##############################################################################
# P99 Baseline Data Collection Script
#
# Purpose: Collect P99 latency baseline over time for threshold tuning
# Usage: ./scripts/collect-p99-baseline.sh [--samples N] [--interval SECONDS]
#
# Output: CSV file with timestamp, P99, success/conflict counts, fallback usage
##############################################################################

set -e

REPO="${GITHUB_REPOSITORY:-zensgit/smartsheet}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
OUTPUT_DIR="$ROOT_DIR/claudedocs/baselines"

# Default parameters
SAMPLES=10
INTERVAL=3600  # 1 hour
WORKFLOW_NAME="Observability Metrics Lite"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --samples)
      SAMPLES="$2"
      shift 2
      ;;
    --interval)
      INTERVAL="$2"
      shift 2
      ;;
    --help)
      echo "Usage: $0 [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --samples N       Number of samples to collect (default: 10)"
      echo "  --interval SEC    Seconds between samples (default: 3600)"
      echo "  --help            Show this help"
      echo ""
      echo "Example:"
      echo "  $0 --samples 20 --interval 1800  # 20 samples every 30 min"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() {
  echo -e "${GREEN}[INFO]${NC} $(date -Iseconds) - $1"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $(date -Iseconds) - $1"
}

##############################################################################
# Setup
##############################################################################

mkdir -p "$OUTPUT_DIR"
OUTPUT_FILE="$OUTPUT_DIR/P99_BASELINE_$(date +%Y%m%d_%H%M%S).csv"

log_info "Starting P99 baseline collection"
log_info "Samples: $SAMPLES, Interval: ${INTERVAL}s"
log_info "Output: $OUTPUT_FILE"
echo ""

# Create CSV header
cat > "$OUTPUT_FILE" << 'EOF'
timestamp,p99_value,success_count,conflict_count,fallback_used,raw_scrape_empty,workflow_run_id
EOF

##############################################################################
# Collection loop
##############################################################################

for i in $(seq 1 "$SAMPLES"); do
  log_info "Collecting sample $i/$SAMPLES..."

  # Get latest workflow run
  RUN_INFO=$(gh run list \
    --repo "$REPO" \
    --branch main \
    --workflow "$WORKFLOW_NAME" \
    --limit 1 \
    --json databaseId,status,conclusion,createdAt \
    -q '.[0]')

  RUN_ID=$(echo "$RUN_INFO" | jq -r '.databaseId // empty')
  RUN_STATUS=$(echo "$RUN_INFO" | jq -r '.status // "unknown"')
  RUN_CONCLUSION=$(echo "$RUN_INFO" | jq -r '.conclusion // "unknown"')

  if [ -z "$RUN_ID" ]; then
    log_warn "No workflow run found. Skipping sample $i."
    echo "$(date -Iseconds),N/A,N/A,N/A,N/A,N/A,N/A" >> "$OUTPUT_FILE"

    # Wait for next sample
    if [ "$i" -lt "$SAMPLES" ]; then
      log_info "Waiting ${INTERVAL}s for next sample..."
      sleep "$INTERVAL"
    fi
    continue
  fi

  log_info "  Run ID: $RUN_ID"
  log_info "  Status: $RUN_STATUS ($RUN_CONCLUSION)"

  # Wait for run to complete if still in progress
  MAX_WAIT=300  # 5 minutes
  WAITED=0
  while [ "$RUN_STATUS" = "in_progress" ] || [ "$RUN_STATUS" = "queued" ]; do
    if [ $WAITED -ge $MAX_WAIT ]; then
      log_warn "  Run still in progress after ${MAX_WAIT}s. Recording as incomplete."
      break
    fi

    log_info "  Run in progress. Waiting 10s..."
    sleep 10
    WAITED=$((WAITED + 10))

    RUN_INFO=$(gh run view "$RUN_ID" --repo "$REPO" --json status,conclusion -q '.')
    RUN_STATUS=$(echo "$RUN_INFO" | jq -r '.status // "unknown"')
    RUN_CONCLUSION=$(echo "$RUN_INFO" | jq -r '.conclusion // "unknown"')
  done

  # Download artifact if run completed
  if [ "$RUN_STATUS" = "completed" ]; then
    ARTIFACT_NAME="approval-final-fallback-summary"
    ARTIFACT_DIR="$OUTPUT_DIR/tmp_$RUN_ID"

    mkdir -p "$ARTIFACT_DIR"

    if gh run download "$RUN_ID" --repo "$REPO" -n "$ARTIFACT_NAME" -D "$ARTIFACT_DIR" 2>/dev/null; then
      SUMMARY_FILE="$ARTIFACT_DIR/approval-final-fallback-summary.txt"

      if [ -f "$SUMMARY_FILE" ]; then
        # Parse metrics
        TIMESTAMP=$(date -Iseconds)
        P99=$(grep 'p99:' "$SUMMARY_FILE" | awk '{print $2}' || echo "N/A")
        SUCCESS=$(grep 'post_fallback_success:' "$SUMMARY_FILE" | awk '{print $2}' || echo "N/A")
        CONFLICT=$(grep 'conflict:' "$SUMMARY_FILE" | awk '{print $2}' || echo "N/A")
        FALLBACK=$(grep 'post_fallback_success:' "$SUMMARY_FILE" | awk '{print $2}' || echo "N/A")
        RAW_EMPTY=$(grep 'raw_scrape_empty:' "$SUMMARY_FILE" | awk '{print $2}' || echo "N/A")

        # Append to CSV
        echo "$TIMESTAMP,$P99,$SUCCESS,$CONFLICT,$FALLBACK,$RAW_EMPTY,$RUN_ID" >> "$OUTPUT_FILE"

        log_info "  ✅ Metrics: P99=${P99}s, Success=$SUCCESS, Conflict=$CONFLICT"
      else
        log_warn "  Summary file not found in artifact"
        echo "$(date -Iseconds),N/A,N/A,N/A,N/A,N/A,$RUN_ID" >> "$OUTPUT_FILE"
      fi

      # Cleanup temp dir
      rm -rf "$ARTIFACT_DIR"
    else
      log_warn "  Failed to download artifact. Run may have no artifacts."
      echo "$(date -Iseconds),N/A,N/A,N/A,N/A,N/A,$RUN_ID" >> "$OUTPUT_FILE"
    fi
  else
    log_warn "  Run not completed (status: $RUN_STATUS, conclusion: $RUN_CONCLUSION)"
    echo "$(date -Iseconds),N/A,N/A,N/A,N/A,N/A,$RUN_ID" >> "$OUTPUT_FILE"
  fi

  # Wait for next sample
  if [ "$i" -lt "$SAMPLES" ]; then
    log_info "Waiting ${INTERVAL}s for next sample..."
    sleep "$INTERVAL"
  fi
done

##############################################################################
# Summary
##############################################################################

log_info "✅ Collection complete: $SAMPLES samples collected"
log_info "Output file: $OUTPUT_FILE"
echo ""

# Calculate basic statistics if we have data
VALID_P99=$(grep -v '^timestamp' "$OUTPUT_FILE" | grep -v 'N/A' | awk -F',' '{print $2}' | grep -E '^[0-9.]+$')

if [ -n "$VALID_P99" ]; then
  log_info "=== P99 Statistics ==="

  # Calculate median, min, max using awk
  echo "$VALID_P99" | awk '
    BEGIN { min=999999; max=0; sum=0; count=0 }
    {
      val = $1
      if (val < min) min = val
      if (val > max) max = val
      sum += val
      values[count++] = val
    }
    END {
      # Sort for median
      for (i = 0; i < count; i++) {
        for (j = i + 1; j < count; j++) {
          if (values[i] > values[j]) {
            temp = values[i]
            values[i] = values[j]
            values[j] = temp
          }
        }
      }
      median = (count % 2 == 0) ? (values[count/2-1] + values[count/2]) / 2 : values[int(count/2)]
      avg = sum / count

      printf "  Min:    %.3f\n", min
      printf "  Max:    %.3f\n", max
      printf "  Median: %.3f\n", median
      printf "  Avg:    %.3f\n", avg
      printf "  Samples: %d\n", count
    }
  '

  echo ""
  log_info "Recommendation: Use median value for threshold tuning"
else
  log_warn "No valid P99 data collected. All runs may have failed or artifacts missing."
fi

log_info "View full data: cat $OUTPUT_FILE"
