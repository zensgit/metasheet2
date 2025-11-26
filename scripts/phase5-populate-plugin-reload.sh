#!/usr/bin/env bash
set -euo pipefail

# Populate plugin reload histogram with multiple samples.
# Uses -unsafe route (requires ALLOW_UNSAFE_ADMIN=true on backend)
# Falls back to SafetyGuard 3-step flow if -unsafe returns 403.

PLUGIN_NAME="${PLUGIN_NAME:-example-plugin}"
RELOAD_COUNT="${RELOAD_COUNT:-10}"
API_BASE="${API_BASE:-http://localhost:8900}"

log() { echo "[plugin-reload] $*"; }
warn() { echo "[plugin-reload] WARN: $*" >&2; }

if ! command -v jq >/dev/null 2>&1; then
  warn "jq is required"; exit 1
fi

# Get JWT token
if [[ -n "${TOKEN:-}" ]]; then
  log "Using existing TOKEN from environment"
elif [[ -x scripts/phase5-dev-jwt.sh ]]; then
  TOKEN=$(./scripts/phase5-dev-jwt.sh)
else
  warn "No TOKEN and scripts/phase5-dev-jwt.sh not found"; exit 1
fi

log "Target plugin: $PLUGIN_NAME, attempts: $RELOAD_COUNT"

# Test which route works
UNSAFE_URL="$API_BASE/api/admin/plugins/$PLUGIN_NAME/reload-unsafe"
SAFE_URL="$API_BASE/api/admin/plugins/$PLUGIN_NAME/reload"

TEST_RESP=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer $TOKEN" -X POST "$UNSAFE_URL")
TEST_CODE=$(echo "$TEST_RESP" | tail -1)
TEST_BODY=$(echo "$TEST_RESP" | sed '$d')

if [[ "$TEST_CODE" == "200" ]]; then
  log "Using -unsafe route (ALLOW_UNSAFE_ADMIN=true detected)"
  USE_UNSAFE=true
elif [[ "$TEST_CODE" == "403" ]]; then
  CODE=$(echo "$TEST_BODY" | jq -r '.code // empty')
  if [[ "$CODE" == "UNSAFE_DISABLED" ]]; then
    log "Falling back to SafetyGuard 3-step flow"
    USE_UNSAFE=false
  else
    warn "403 but not UNSAFE_DISABLED: $TEST_BODY"
    USE_UNSAFE=false
  fi
else
  warn "Unexpected response ($TEST_CODE): $TEST_BODY"
  USE_UNSAFE=false
fi

success_count=0

for i in $(seq 1 "$RELOAD_COUNT"); do
  if [[ "$USE_UNSAFE" == "true" ]]; then
    # Simple -unsafe route
    RESP=$(curl -s -H "Authorization: Bearer $TOKEN" -X POST "$UNSAFE_URL")
    SUCCESS=$(echo "$RESP" | jq -r '.success // false')
    if [[ "$SUCCESS" == "true" ]]; then
      ((success_count++))
      log "$i/$RELOAD_COUNT success (unsafe)"
    else
      warn "$i/$RELOAD_COUNT failed: $(echo "$RESP" | jq -c '.')"
    fi
  else
    # SafetyGuard 3-step flow:
    # Step 1: Request reload to get token (returns 403 SAFETY_CHECK_REQUIRED)
    STEP1=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer $TOKEN" -X POST "$SAFE_URL")
    STEP1_CODE=$(echo "$STEP1" | tail -1)
    STEP1_BODY=$(echo "$STEP1" | sed '$d')

    if [[ "$STEP1_CODE" == "200" ]]; then
      # SafetyGuard might be disabled, direct success
      SUCCESS=$(echo "$STEP1_BODY" | jq -r '.success // false')
      if [[ "$SUCCESS" == "true" ]]; then
        ((success_count++))
        log "$i/$RELOAD_COUNT success (direct)"
      fi
      sleep 0.3
      continue
    fi

    CONFIRM_TOKEN=$(echo "$STEP1_BODY" | jq -r '.confirmation.token // .confirmationToken // .token // empty')
    if [[ -z "$CONFIRM_TOKEN" ]]; then
      warn "$i/$RELOAD_COUNT no token in step1: $STEP1_BODY"
      sleep 0.3
      continue
    fi

    # Step 2: Confirm with acknowledgment
    STEP2=$(curl -s -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -X POST "$API_BASE/api/admin/safety/confirm" \
      -d "{\"token\":\"$CONFIRM_TOKEN\",\"acknowledged\":true}")
    STEP2_OK=$(echo "$STEP2" | jq -r '.success // .valid // false')
    if [[ "$STEP2_OK" != "true" ]]; then
      warn "$i/$RELOAD_COUNT confirm failed: $STEP2"
      sleep 0.3
      continue
    fi

    # Step 3: Retry with confirmed token
    STEP3=$(curl -s -H "Authorization: Bearer $TOKEN" \
      -H "x-safety-token: $CONFIRM_TOKEN" \
      -X POST "$SAFE_URL")
    SUCCESS=$(echo "$STEP3" | jq -r '.success // false')
    if [[ "$SUCCESS" == "true" ]]; then
      ((success_count++))
      log "$i/$RELOAD_COUNT success (safetyguard)"
    else
      warn "$i/$RELOAD_COUNT reload failed: $STEP3"
    fi
  fi
  sleep 0.3
done

log "Completed: $success_count/$RELOAD_COUNT successful reloads"

# Verify metrics
log "Checking metrics for histogram/count..."
METRICS=$(curl -s "$API_BASE/metrics/prom")

if echo "$METRICS" | grep -qE 'metasheet_plugin_reload_duration_seconds_count'; then
  COUNT=$(echo "$METRICS" | grep -E "metasheet_plugin_reload_duration_seconds_count{.*$PLUGIN_NAME" | head -1 | awk '{print $2}')
  log "Histogram count for $PLUGIN_NAME: ${COUNT:-0}"
else
  warn "Histogram not found in metrics output"
fi

echo "$METRICS" | grep -E 'metasheet_plugin_reload_total{.*result="success"}' | head -n1 || true

log "Done."
