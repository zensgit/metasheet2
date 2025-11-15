#!/bin/bash
# Phase 3: 24-Hour Observation Script
# 24小时持续监控observability指标

set -e

# Single-instance lock (prevent duplicate observers)
LOCK_DIR=${OUT_DIR:-"artifacts"}
LOCK_FILE="$LOCK_DIR/.observe-24h.lock"
mkdir -p "$LOCK_DIR"
if [ -f "$LOCK_FILE" ]; then
  if ps -p $(cat "$LOCK_FILE") > /dev/null 2>&1; then
    echo "🛑 Another observation (PID $(cat "$LOCK_FILE")) is running. Exiting." >&2
    exit 1
  else
    echo "⚠️ Stale lock file found (PID $(cat "$LOCK_FILE")), overwriting." >&2
  fi
fi
echo $$ > "$LOCK_FILE"

# Ensure lock removal on exit
cleanup_lock() { rm -f "$LOCK_FILE" 2>/dev/null || true; }
trap cleanup_lock EXIT INT TERM

# Configuration
REPO="zensgit/smartsheet"
PR_BRANCH="ci/observability-hardening"
STRICT_WF="observability-strict.yml"
METRICS_URL=${METRICS_URL:-""}              # Production Prometheus endpoint (preferred)
INTERVAL_SECONDS=${INTERVAL_SECONDS:-1800}  # Default: 30 minutes (48 samples/24h)
MAX_SAMPLES=${MAX_SAMPLES:-48}              # 24 hours of 30-min samples
ARTIFACTS_DIR=${OUT_DIR:-"artifacts"}
ALERTS_DIR="alerts"
CSV_FILE="$ARTIFACTS_DIR/observability-24h.csv"
SUMMARY_FILE="$ARTIFACTS_DIR/observability-24h-summary.json"
STOP_FILE="$ARTIFACTS_DIR/STOP_OBSERVATION"
CRITICAL_ALERT_FILE="$ALERTS_DIR/observability-critical.txt"
REPORT_DIR="claudedocs"

# Alert hooks (optional)
ALERT_WEBHOOK_URL=${ALERT_WEBHOOK_URL:-""}  # Slack/Webhook for CRIT alerts
HOOK_CRIT_CMD=${HOOK_CRIT_CMD:-""}          # Custom command on CRIT
CREATE_GH_ISSUE=${CREATE_GH_ISSUE:-"false"} # Auto-create GitHub issues

# Cold start exemption and smoothing
COLD_START_SAMPLES=1                        # Skip alerts for first N samples
SMOOTHING_WINDOW=3                          # Use median of last N for P99

# Thresholds
SUCCESS_RATE_WARN=0.98
SUCCESS_RATE_CRIT=0.95
CONFLICTS_WARN=1
CONFLICTS_CRIT=2
FALLBACK_RATIO_WARN=0.10
FALLBACK_RATIO_CRIT=0.25
P99_WARN=0.30
P99_CRIT=0.40

# Consecutive failure tracking
CONSECUTIVE_FALLBACK_HIGH=0
CONSECUTIVE_SUCCESS_LOW=0
CONSECUTIVE_CONFLICT_HIGH=0
CONSECUTIVE_P99_HIGH=0

echo "🚀 Starting Phase 3: 24-Hour Observation"
echo "📊 Sampling interval: ${INTERVAL_SECONDS}s ($(echo "$INTERVAL_SECONDS / 60" | bc) minutes)"
echo "🎯 Maximum samples: $MAX_SAMPLES"
echo "📁 CSV output: $CSV_FILE"
echo "📄 Summary output: $SUMMARY_FILE"
echo "🚨 Critical alerts: $CRITICAL_ALERT_FILE"
echo ""
echo "⚙️ Thresholds:"
echo "  - Success Rate: WARN <${SUCCESS_RATE_WARN}, CRIT <${SUCCESS_RATE_CRIT}"
echo "  - Conflicts: WARN =${CONFLICTS_WARN}, CRIT ≥${CONFLICTS_CRIT}"
echo "  - Fallback Ratio: WARN >${FALLBACK_RATIO_WARN}, CRIT >${FALLBACK_RATIO_CRIT}"
echo "  - P99 Latency: WARN >${P99_WARN}s, CRIT >${P99_CRIT}s"
echo "  - Cold Start Exemption: First ${COLD_START_SAMPLES} samples"
echo "  - P99 Smoothing: Median of last ${SMOOTHING_WINDOW} samples"
echo ""
echo "🔔 Alert Hooks:"
echo "  - Webhook: ${ALERT_WEBHOOK_URL:-disabled}"
echo "  - Custom CMD: ${HOOK_CRIT_CMD:-disabled}"
echo "  - GitHub Issues: ${CREATE_GH_ISSUE}"
echo ""
echo "🛑 To stop observation early: touch $STOP_FILE"
echo ""

# Initialize alerts directory
mkdir -p "$ALERTS_DIR"

# Ensure artifacts directory exists before writing files
mkdir -p "$ARTIFACTS_DIR"

# Record PID for monitoring
echo $$ > "$ARTIFACTS_DIR/observation.pid"
echo "📋 Observation PID: $$ (saved to $ARTIFACTS_DIR/observation.pid)"
echo ""

 # Initialize or reuse CSV file (add header if new)
if [ ! -f "$CSV_FILE" ]; then
  cat > "$CSV_FILE" << 'EOF'
timestamp,sample_num,run_id,approval_success,approval_conflict,post_fallback_success,p99_latency,db_p99_latency,success_rate,fallback_ratio,status,alert_flags
EOF
  echo "✅ Initialized CSV file: $CSV_FILE"
else
  echo "🔁 Reusing existing CSV file: $CSV_FILE"
fi

# Initialize summary JSON
cat > "$SUMMARY_FILE" << EOF
{
  "observation_start": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "interval_seconds": $INTERVAL_SECONDS,
  "max_samples": $MAX_SAMPLES,
  "samples_collected": 0,
  "alerts": [],
  "status": "running"
}
EOF
echo "✅ Initialized summary file: $SUMMARY_FILE"

# Retry wrapper for gh commands (3x retry with backoff)
gh_retry() {
  local attempt=1
  local max_attempts=3
  local output

  while [ $attempt -le $max_attempts ]; do
    output=$("$@" 2>&1)
    local exit_code=$?

    if [ $exit_code -eq 0 ]; then
      echo "$output"
      return 0
    fi

    if [ $attempt -lt $max_attempts ]; then
      echo "⚠️  gh command failed (attempt $attempt), retrying..." >&2
      sleep $((attempt * 2))  # Exponential backoff: 2s, 4s
    fi
    attempt=$((attempt + 1))
  done

  echo "❌ gh command failed after $max_attempts attempts" >&2
  echo "$output"
  return 1
}

# Webhook cooldown tracking
LAST_WEBHOOK_TIME=0
WEBHOOK_COOLDOWN_SECONDS=300  # 5 minutes

# Function to collect metrics from production Prometheus endpoint
collect_metrics_from_prom() {
  # Add timeout and retry for robustness
  local metrics_data=""
  local attempt=1
  local max_attempts=3

  while [ $attempt -le $max_attempts ]; do
    metrics_data=$(curl -s --max-time 10 "$METRICS_URL" 2>/dev/null || echo "")

    if [ -n "$metrics_data" ]; then
      break
    fi

    if [ $attempt -lt $max_attempts ]; then
      echo "⚠️  Attempt $attempt failed, retrying..."
      sleep 2
    fi
    attempt=$((attempt + 1))
  done

  if [ -z "$metrics_data" ]; then
    echo "⚠️  WARNING: Failed to fetch metrics from $METRICS_URL after $max_attempts attempts"
    return 1
  fi

  # Parse Prometheus metrics format
  local approval_success=$(echo "$metrics_data" | awk '/^metasheet_approval_actions_total\{[^}]*result="success"/ {sum+=$NF} END {print (sum==""?0:sum)}')
  local approval_conflict=$(echo "$metrics_data" | awk '/^metasheet_approval_(actions_total\{[^}]*result="conflict"|conflict_total)/ {sum+=$NF} END {print (sum==""?0:sum)}')
  local post_fallback=$(echo "$metrics_data" | awk '/^metasheet_approval_fallback_success_total/ {sum+=$NF} END {print (sum==""?0:sum)}')
  local p99=$(echo "$metrics_data" | awk '/^metasheet_approval_duration_seconds\{[^}]*quantile="0.99"/ {p=$NF} END {print (p==""?0:p)}')
  local dbp99=$(echo "$metrics_data" | awk '/^metasheet_db_query_duration_seconds\{[^}]*quantile="0.99"/ {d=$NF} END {print (d==""?0:d)}')

  echo "$approval_success $approval_conflict $post_fallback $p99 $dbp99 prom"
  return 0
}

# Function to collect metrics from latest successful PR run (fallback)
collect_metrics_from_ci() {
  # Find latest successful v2-observability-strict run (with retry)
  local run_data=$(gh_retry gh run list --repo $REPO --branch $PR_BRANCH \
    --workflow "$STRICT_WF" --event pull_request --limit 5 \
    --json databaseId,conclusion,createdAt \
    --jq '[.[] | select(.conclusion == "success")] | .[0]')

  if [ -z "$run_data" ] || [ "$run_data" = "null" ]; then
    echo "⚠️  WARNING: No successful runs found"
    return 1
  fi

  local run_id=$(echo $run_data | jq -r '.databaseId')
  local run_time=$(echo $run_data | jq -r '.createdAt')

  echo "📊 Using run: $run_id (created: $run_time)" >&2

  # Extract metrics from run logs (with retry)
  local log_file="/tmp/obs_metrics_${run_id}.txt"
  gh_retry gh run view $run_id --log --repo $REPO 2>&1 | \
    grep -E "approval_success|post_fallback|conflict|p99_latency|db_p99" | \
    tail -30 > "$log_file" || true

  # Parse metrics with awk (portable, strips trailing commas/whitespace)
  local approval_success=$(awk -F': ' '/approval_success/ && !/approval_conflict/ {gsub(/[,; \t\r\n]+$/, "", $2); s=$2} END {print (s==""?0:s)}' "$log_file" 2>/dev/null || echo "0")
  local approval_conflict=$(awk -F': ' '/approval_conflict|conflict/ {gsub(/[,; \t\r\n]+$/, "", $2); c=$2} END {print (c==""?0:c)}' "$log_file" 2>/dev/null || echo "0")
  local post_fallback=$(awk -F': ' '/post_fallback_success/ {gsub(/[,; \t\r\n]+$/, "", $2); f=$2} END {print (f==""?0:f)}' "$log_file" 2>/dev/null || echo "0")
  local p99=$(awk -F': ' '/p99_latency/ && !/db_p99/ {gsub(/[,; \t\r\n]+$/, "", $2); p=$2} END {print (p==""?0:p)}' "$log_file" 2>/dev/null || echo "0")
  local dbp99=$(awk -F': ' '/db_p99_latency/ {gsub(/[,; \t\r\n]+$/, "", $2); d=$2} END {print (d==""?0:d)}' "$log_file" 2>/dev/null || echo "0")

  # Clean up log file
  rm -f "$log_file"

  echo "$approval_success $approval_conflict $post_fallback $p99 $dbp99 ci:$run_id"
  return 0
}

# Function to collect metrics (with source selection)
collect_metrics() {
  local sample_num=$1

  echo ""
  echo "=== Sample #$sample_num at $(date) ==="

  # Try production metrics first if METRICS_URL is set
  local metrics_result=""
  local data_source="unknown"
  local run_id=""  # unified identifier written to CSV (prom or CI run id)

  if [ -n "$METRICS_URL" ]; then
    echo "📊 Data source: Production Prometheus ($METRICS_URL)"
    metrics_result=$(collect_metrics_from_prom)
    if [ $? -eq 0 ]; then
      read -r approval_success approval_conflict post_fallback p99 dbp99 data_source <<< "$metrics_result"
      run_id="prom"
    else
      echo "⚠️  Production metrics unavailable, falling back to CI logs"
      METRICS_URL=""  # Disable for remaining samples
    fi
  fi

  # Fall back to CI logs if production unavailable
  if [ -z "$METRICS_URL" ]; then
    echo "📊 Data source: CI workflow logs (fallback)"
    metrics_result=$(collect_metrics_from_ci)
    if [ $? -ne 0 ]; then
      return 1
    fi
    read -r approval_success approval_conflict post_fallback p99 dbp99 data_source <<< "$metrics_result"
    # data_source format: ci:<run_id>
    if [[ "$data_source" == ci:* ]]; then
      run_id="${data_source#ci:}"
    else
      run_id="$data_source"
    fi
  fi

  echo "📈 Raw metrics:"
  echo "   approval_success: $approval_success"
  echo "   approval_conflict: $approval_conflict"
  echo "   post_fallback_success: $post_fallback"
  echo "   p99_latency: $p99"
  echo "   db_p99_latency: $dbp99"

  # Apply P99 smoothing (median of last N samples)
  if [ $sample_num -ge $SMOOTHING_WINDOW ]; then
    local p99_smoothed=$(tail -n $SMOOTHING_WINDOW "$CSV_FILE" 2>/dev/null | awk -F',' '{print $7}' | sort -n | awk 'NR==2 {print}')
    if [ -n "$p99_smoothed" ] && [[ $p99_smoothed =~ ^[0-9.]+$ ]]; then
      echo "   p99_smoothed (median of last $SMOOTHING_WINDOW): $p99_smoothed"
      p99=$p99_smoothed  # Use smoothed value for threshold checks
    fi
  fi

  # Calculate ratios (using bc for floating point)
  local success_rate="0"
  local fallback_ratio="0"

  if [[ $approval_success =~ ^[0-9]+$ ]] && [[ $approval_conflict =~ ^[0-9]+$ ]]; then
    local total=$((approval_success + approval_conflict))
    if [ "$total" -gt 0 ]; then
      success_rate=$(echo "scale=4; $approval_success / $total" | bc)
    fi
  fi

  if [[ $post_fallback =~ ^[0-9]+$ ]] && [[ $approval_success =~ ^[0-9]+$ ]]; then
    if [ "$approval_success" -gt 0 ]; then
      fallback_ratio=$(echo "scale=4; $post_fallback / $approval_success" | bc)
    fi
  fi

echo "📊 Calculated metrics:"
echo "   success_rate: $success_rate (target: >${SUCCESS_RATE_WARN})"
echo "   fallback_ratio: $fallback_ratio (target: <${FALLBACK_RATIO_WARN})"

# Determine status and alerts
local status="OK"
local alert_flags=""
local is_critical=false

# Detect potential transient collection gap (CI log window empty)
# Heuristic: success_rate == 0 and no conflicts and no fallback successes in this sample
local is_collection_gap=false
if [[ $success_rate =~ ^[0-9.]+$ ]] && [[ $approval_conflict =~ ^[0-9]+$ ]] && [[ $post_fallback =~ ^[0-9]+$ ]]; then
  if (( $(echo "$success_rate == 0" | bc -l) )) && [ "$approval_conflict" -eq 0 ] && [ "$post_fallback" -eq 0 ]; then
    is_collection_gap=true
    alert_flags="${alert_flags}collect_empty_source,"
  fi
fi

  # Skip alerts for cold start samples
  if [ $sample_num -le $COLD_START_SAMPLES ]; then
    echo "❄️  Cold start sample - skipping alert checks"
    status="COLD_START"
    alert_flags="cold_start"
  else

    # Check success rate
    if [[ $success_rate =~ ^[0-9.]+$ ]]; then
      if (( $(echo "$success_rate < $SUCCESS_RATE_CRIT" | bc -l) )); then
        status="CRIT"
        is_critical=true
        alert_flags="${alert_flags}success_rate_crit,"
        CONSECUTIVE_SUCCESS_LOW=$((CONSECUTIVE_SUCCESS_LOW + 1))
        echo "🔴 CRITICAL: Success rate $success_rate < $SUCCESS_RATE_CRIT"
      elif (( $(echo "$success_rate < $SUCCESS_RATE_WARN" | bc -l) )); then
        if [ "$status" = "OK" ]; then status="WARN"; fi
        alert_flags="${alert_flags}success_rate_warn,"
        CONSECUTIVE_SUCCESS_LOW=$((CONSECUTIVE_SUCCESS_LOW + 1))
        echo "⚠️  WARNING: Success rate $success_rate < $SUCCESS_RATE_WARN"
      else
        CONSECUTIVE_SUCCESS_LOW=0
      fi
    fi

    # Check conflicts
    if [[ $approval_conflict =~ ^[0-9]+$ ]]; then
      if [ "$approval_conflict" -ge "$CONFLICTS_CRIT" ]; then
        status="CRIT"
        is_critical=true
        alert_flags="${alert_flags}conflicts_crit,"
        CONSECUTIVE_CONFLICT_HIGH=$((CONSECUTIVE_CONFLICT_HIGH + 1))
        echo "🔴 CRITICAL: Conflicts $approval_conflict ≥ $CONFLICTS_CRIT"
      elif [ "$approval_conflict" -ge "$CONFLICTS_WARN" ]; then
        if [ "$status" = "OK" ]; then status="WARN"; fi
        alert_flags="${alert_flags}conflicts_warn,"
        CONSECUTIVE_CONFLICT_HIGH=$((CONSECUTIVE_CONFLICT_HIGH + 1))
        echo "⚠️  WARNING: Conflicts $approval_conflict ≥ $CONFLICTS_WARN"
      else
        CONSECUTIVE_CONFLICT_HIGH=0
      fi
    fi

    # Check fallback ratio
    if [[ $fallback_ratio =~ ^[0-9.]+$ ]]; then
      if (( $(echo "$fallback_ratio > $FALLBACK_RATIO_CRIT" | bc -l) )); then
        status="CRIT"
        is_critical=true
        alert_flags="${alert_flags}fallback_crit,"
        CONSECUTIVE_FALLBACK_HIGH=$((CONSECUTIVE_FALLBACK_HIGH + 1))
        echo "🔴 CRITICAL: Fallback ratio $fallback_ratio > $FALLBACK_RATIO_CRIT"
      elif (( $(echo "$fallback_ratio > $FALLBACK_RATIO_WARN" | bc -l) )); then
        if [ "$status" = "OK" ]; then status="WARN"; fi
        alert_flags="${alert_flags}fallback_warn,"
        CONSECUTIVE_FALLBACK_HIGH=$((CONSECUTIVE_FALLBACK_HIGH + 1))
        echo "⚠️  WARNING: Fallback ratio $fallback_ratio > $FALLBACK_RATIO_WARN"
      else
        CONSECUTIVE_FALLBACK_HIGH=0
      fi
    fi

    # Check P99 latency
    if [[ $p99 =~ ^[0-9.]+$ ]]; then
      if (( $(echo "$p99 > $P99_CRIT" | bc -l) )); then
        status="CRIT"
        is_critical=true
        alert_flags="${alert_flags}p99_crit,"
        CONSECUTIVE_P99_HIGH=$((CONSECUTIVE_P99_HIGH + 1))
        echo "🔴 CRITICAL: P99 latency $p99 > $P99_CRIT"
      elif (( $(echo "$p99 > $P99_WARN" | bc -l) )); then
        if [ "$status" = "OK" ]; then status="WARN"; fi
        alert_flags="${alert_flags}p99_warn,"
        CONSECUTIVE_P99_HIGH=$((CONSECUTIVE_P99_HIGH + 1))
        echo "⚠️  WARNING: P99 latency $p99 > $P99_WARN"
      else
        CONSECUTIVE_P99_HIGH=0
      fi
    fi

    # Check consecutive failures (triggers critical alert file)
    if [ "$CONSECUTIVE_FALLBACK_HIGH" -ge 2 ]; then
      is_critical=true
      echo "🔴 ALERT: Consecutive high fallback ratio (${CONSECUTIVE_FALLBACK_HIGH} times)"
      alert_flags="${alert_flags}consecutive_fallback,"
    fi
    if [ "$CONSECUTIVE_SUCCESS_LOW" -ge 2 ]; then
      is_critical=true
      echo "🔴 ALERT: Consecutive low success rate (${CONSECUTIVE_SUCCESS_LOW} times)"
      alert_flags="${alert_flags}consecutive_success,"
    fi
    if [ "$CONSECUTIVE_CONFLICT_HIGH" -ge 2 ]; then
      is_critical=true
      echo "🔴 ALERT: Consecutive high conflicts (${CONSECUTIVE_CONFLICT_HIGH} times)"
      alert_flags="${alert_flags}consecutive_conflict,"
    fi
    if [ "$CONSECUTIVE_P99_HIGH" -ge 2 ]; then
      is_critical=true
      echo "🔴 ALERT: Consecutive high P99 latency (${CONSECUTIVE_P99_HIGH} times)"
      alert_flags="${alert_flags}consecutive_p99,"
    fi
  fi  # End cold start check

  # Strip trailing comma
  alert_flags=${alert_flags%,}

  # Append to CSV
  local timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  echo "$timestamp,$sample_num,$run_id,$approval_success,$approval_conflict,$post_fallback,$p99,$dbp99,$success_rate,$fallback_ratio,$status,\"$alert_flags\"" >> "$CSV_FILE"

  # Dedupe CSV on timestamp (keep first occurrence)
  tmp_csv="${CSV_FILE}.tmp"; awk -F',' 'NR==1{print;next}!seen[$1]++' "$CSV_FILE" > "$tmp_csv" && mv "$tmp_csv" "$CSV_FILE"
  echo "🧹 Dedupe applied on $CSV_FILE (by timestamp)"

  echo "✅ Status: $status"
  if [ -n "$alert_flags" ]; then
    echo "🚨 Alert flags: $alert_flags"
  fi

  # Update summary JSON
  local samples_collected=$sample_num
  jq --arg ts "$timestamp" \
     --arg status "$status" \
     --arg alerts "$alert_flags" \
     --argjson samples "$samples_collected" \
     '.samples_collected = $samples | .last_update = $ts | .last_status = $status | if $alerts != "" then .alerts += [$ts + ": " + $alerts] else . end' \
     "$SUMMARY_FILE" > "${SUMMARY_FILE}.tmp" && mv "${SUMMARY_FILE}.tmp" "$SUMMARY_FILE"

  echo "📄 Updated summary: $SUMMARY_FILE"

  # Write critical alert file if critical status detected
  if [ "$is_critical" = true ]; then
    echo "🚨 CRITICAL ALERT - Writing to $CRITICAL_ALERT_FILE"

    # Collect additional context
    local source_label="Unknown"
    local run_link=""
    if [ "$run_id" = "prom" ]; then
      source_label="Production Prometheus ($METRICS_URL)"
    elif [[ "$run_id" =~ ^[0-9]+$ ]]; then
      source_label="CI Workflow Logs"
      run_link="https://github.com/$REPO/actions/runs/$run_id"
    fi

    # Get recent workflow runs for context
    local recent_runs=$(gh run list --repo $REPO --branch $PR_BRANCH \
      --workflow "$STRICT_WF" --limit 3 --json databaseId,conclusion,createdAt,status \
      --jq '.[] | "\(.databaseId) | \(.status) | \(.conclusion // "in_progress") | \(.createdAt)"' 2>/dev/null || echo "Unable to fetch recent runs")

    cat >> "$CRITICAL_ALERT_FILE" << EOF

================================================================================
CRITICAL ALERT - Sample #$sample_num
Time: $timestamp
Status: $status
Alert Flags: $alert_flags
================================================================================

Data Source: $source_label
$([ -n "$run_link" ] && echo "Run URL: $run_link" || echo "")

Metrics:
  - Approval Success: $approval_success
  - Approval Conflict: $approval_conflict
  - Post Fallback: $post_fallback
  - P99 Latency: ${p99}s
  - Success Rate: $success_rate
  - Fallback Ratio: $fallback_ratio

Recent 10 Samples:
$(tail -10 "$CSV_FILE")

Recent Workflow Runs (Last 3):
$recent_runs

Investigation Commands:
  # View this run's details
  $([ -n "$run_link" ] && echo "gh run view $run_id --repo $REPO --log" || echo "N/A - using Prometheus data")

  # Check current metrics
  curl -s $METRICS_URL | grep -E "approval_(actions_total|conflict_total)"

  # View observation log
  tail -50 artifacts/observe-24h.log

EOF

    # Trigger webhook if configured (with cooldown)
    if [ -n "$ALERT_WEBHOOK_URL" ]; then
      local current_time=$(date +%s)
      local time_since_last=$((current_time - LAST_WEBHOOK_TIME))

      if [ $time_since_last -ge $WEBHOOK_COOLDOWN_SECONDS ]; then
        echo "📡 Sending alert to webhook..."
        curl -s --max-time 10 -X POST "$ALERT_WEBHOOK_URL" \
          -H "Content-Type: application/json" \
          -d "{\"text\":\"🚨 Observability CRITICAL Alert\",\"sample\":$sample_num,\"status\":\"$status\",\"alerts\":\"$alert_flags\",\"success_rate\":$success_rate}" \
          || echo "⚠️  Webhook failed"
        LAST_WEBHOOK_TIME=$current_time
      else
        local wait_time=$((WEBHOOK_COOLDOWN_SECONDS - time_since_last))
        echo "⏸️  Webhook cooldown active (${wait_time}s remaining)"
      fi
    fi

    # Execute custom hook if configured
    if [ -n "$HOOK_CRIT_CMD" ]; then
      echo "⚡ Executing custom hook..."
      eval "$HOOK_CRIT_CMD" || echo "⚠️  Hook failed"
    fi

    # Create GitHub issue if enabled
    if [ "$CREATE_GH_ISSUE" = "true" ]; then
      echo "📝 Creating GitHub issue..."

      # Build issue body with enhanced context
      local issue_body="## Critical Alert Details

**Time**: $timestamp
**Sample**: #$sample_num
**Status**: $status
**Alert Flags**: $alert_flags

## Metrics

- **Success Rate**: $success_rate (target: ≥0.98)
- **Conflicts**: $approval_conflict (target: 0)
- **Fallback Ratio**: $fallback_ratio (target: <0.10)
- **P99 Latency**: ${p99}s (target: <0.30s)

## Data Source

- **Source**: $source_label"

      if [ -n "$run_link" ]; then
        issue_body="$issue_body
- **Run URL**: $run_link"
      fi

      issue_body="$issue_body

## Investigation

\`\`\`bash
# View critical alert details
cat $CRITICAL_ALERT_FILE

# Check observation status
tail -20 artifacts/observe-24h.log

# View recent samples
tail -10 artifacts/observability-24h.csv
\`\`\`

---

**Alert File**: \`$CRITICAL_ALERT_FILE\`
**Observation Started**: $(jq -r '.observation_start' \"$SUMMARY_FILE\")
**Current Progress**: $sample_num / $MAX_SAMPLES samples"

      # Build label flags (support multiple labels)
      local label_flags="--label observability --label critical --label needs-attention"
      if echo "$alert_flags" | grep -q "collect_empty_source"; then
        label_flags="$label_flags --label transient"
      fi

      gh issue create --repo $REPO \
        --title "🚨 Observability Critical Alert - Sample #$sample_num ($timestamp)" \
        --body "$issue_body" \
        $label_flags \
        || echo "⚠️  GitHub issue creation failed"
    fi
  fi

  return 0
}

# Main observation loop
echo "🔄 Starting observation loop..."
echo ""

sample_num=0

while [ $sample_num -lt $MAX_SAMPLES ]; do
  # Check for stop file
  if [ -f "$STOP_FILE" ]; then
    echo ""
    echo "🛑 Stop file detected: $STOP_FILE"
    echo "🏁 Stopping observation early (collected $sample_num samples)"
    rm -f "$STOP_FILE"
    break
  fi

  sample_num=$((sample_num + 1))

  # Collect metrics
  if ! collect_metrics $sample_num; then
    echo "⚠️  Failed to collect sample #$sample_num, will retry next interval"
  fi

  # Check if we should continue
  if [ $sample_num -lt $MAX_SAMPLES ]; then
    echo ""
    echo "⏳ Waiting ${INTERVAL_SECONDS}s until next sample..."
    echo "   Progress: $sample_num / $MAX_SAMPLES samples collected"
    echo "   Next sample at: $(date -d "+${INTERVAL_SECONDS} seconds" 2>/dev/null || date -v+${INTERVAL_SECONDS}S 2>/dev/null || echo "$(date) + ${INTERVAL_SECONDS}s")"
    sleep $INTERVAL_SECONDS
  fi
done

# Finalize summary
jq --arg end "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
   '.observation_end = $end | .status = "completed"' \
   "$SUMMARY_FILE" > "${SUMMARY_FILE}.tmp" && mv "${SUMMARY_FILE}.tmp" "$SUMMARY_FILE"

echo ""
echo "✅ Observation complete!"
cleanup_lock
echo "📊 Total samples collected: $sample_num"
echo "📄 CSV data: $CSV_FILE"
echo "📄 Summary: $SUMMARY_FILE"
echo ""
echo "🔍 To generate final report:"
echo "   bash scripts/generate-phase3-report.sh"
