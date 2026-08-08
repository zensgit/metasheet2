#!/usr/bin/env bash
# Approval Canvas residual G5-C owner UAT smoke harness (values-free).
#
# PLAN_ID=6fa2fbf6 PR3 — checklist runner for owner handoff preflight.
# Does NOT flip env flags, does NOT claim product FINAL, does NOT hit real tenants.
#
# Usage:
#   scripts/ops/approval-canvas-owner-uat-smoke.sh
#   SKIP_TESTS=1 scripts/ops/approval-canvas-owner-uat-smoke.sh
#
# Exit 0 on pass; non-zero on any hard check failure.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

SKIP_TESTS="${SKIP_TESTS:-0}"
failures=0

log() { printf '%s\n' "$*"; }
ok() { log "OK: $*"; }
fail() { log "FAIL: $*"; failures=$((failures + 1)); }

log "=== approval-canvas-owner-uat-smoke ==="
log "land_sha=$(git rev-parse HEAD)"
log "cwd=${ROOT_DIR}"
log "SKIP_TESTS=${SKIP_TESTS}"

# ---------------------------------------------------------------------------
# 1) Frontend product default: approvalCanvasV2 remains false
#    (DEFAULT_FEATURES / featureDefaults surface in featureFlags.ts)
# ---------------------------------------------------------------------------
FEATURE_FLAGS="apps/web/src/stores/featureFlags.ts"
if [[ ! -f "$FEATURE_FLAGS" ]]; then
  fail "missing ${FEATURE_FLAGS}"
else
  if grep -qE 'approvalCanvasV2:\s*false' "$FEATURE_FLAGS"; then
    ok "approvalCanvasV2 default false in ${FEATURE_FLAGS}"
  else
    fail "expected approvalCanvasV2: false in ${FEATURE_FLAGS} (featureDefaults/DEFAULT_FEATURES)"
  fi
fi

# ---------------------------------------------------------------------------
# 2) Backend env gate: APPROVAL_CANVAS_V2_ENABLED strict true only via flag service
# ---------------------------------------------------------------------------
FLAG_SVC="packages/core-backend/src/services/approval-canvas-flag.ts"
if [[ ! -f "$FLAG_SVC" ]]; then
  fail "missing ${FLAG_SVC}"
else
  if grep -q "APPROVAL_CANVAS_V2_ENABLED" "$FLAG_SVC" \
    && grep -qE "=== ['\"]true['\"]" "$FLAG_SVC"; then
    ok "APPROVAL_CANVAS_V2_ENABLED strict === 'true' gate in approval-canvas-flag.ts"
  else
    fail "expected APPROVAL_CANVAS_V2_ENABLED === 'true' only in ${FLAG_SVC}"
  fi
fi

# Ensure no other runtime source files implement a looser env enable path.
# Docs/tests may mention the env var; only the service module may define the gate.
while IFS= read -r path; do
  [[ -z "$path" ]] && continue
  case "$path" in
    packages/core-backend/src/services/approval-canvas-flag.ts) continue ;;
    packages/core-backend/tests/*) continue ;;
    docs/*) continue ;;
    *)
      fail "APPROVAL_CANVAS_V2_ENABLED appears outside approval-canvas-flag.ts: ${path}"
      ;;
  esac
done < <(
  # Restrict to runtime/source trees; ignore docs and tests for this uniqueness pin.
  if command -v rg >/dev/null 2>&1; then
    rg -l --glob '!docs/**' --glob '!**/tests/**' --glob '!**/*.md' \
      'APPROVAL_CANVAS_V2_ENABLED' \
      packages/core-backend/src apps 2>/dev/null || true
  else
    grep -rl 'APPROVAL_CANVAS_V2_ENABLED' packages/core-backend/src apps 2>/dev/null \
      | grep -v '/tests/' || true
  fi
)

# ---------------------------------------------------------------------------
# 3) Owner handoff doc present
# ---------------------------------------------------------------------------
HANDOFF="docs/development/approval-canvas-data-closure-owner-handoff-20260808.md"
if [[ -f "$HANDOFF" ]]; then
  ok "owner handoff present: ${HANDOFF}"
else
  fail "missing owner handoff ${HANDOFF}"
fi

# Residual design ledger (PLAN 6fa2fbf6) present on this branch
LEDGER="docs/development/approval-canvas-residual-parallel-design-20260808.md"
if [[ -f "$LEDGER" ]]; then
  if grep -q '6fa2fbf6' "$LEDGER"; then
    ok "residual design ledger PLAN_ID 6fa2fbf6: ${LEDGER}"
  else
    fail "ledger present but PLAN_ID 6fa2fbf6 missing: ${LEDGER}"
  fi
else
  fail "missing residual design ledger ${LEDGER}"
fi

# ---------------------------------------------------------------------------
# 4) Optional focused vitest (history + g5c). Skippable via SKIP_TESTS=1.
# ---------------------------------------------------------------------------
if [[ "$SKIP_TESTS" == "1" ]]; then
  ok "SKIP_TESTS=1 — skipping focused vitest (history + g5c)"
else
  if ! command -v pnpm >/dev/null 2>&1; then
    log "WARN: pnpm not available — skipping focused vitest"
  else
    log "Running focused vitest: approval-authoring-history + approval-g5c-authoring-scenarios"
    if pnpm --filter @metasheet/web exec vitest run --watch=false \
      tests/approval-authoring-history.test.ts \
      tests/approval-g5c-authoring-scenarios.test.ts \
      --reporter=dot; then
      ok "focused vitest (history + g5c) passed"
    else
      fail "focused vitest (history + g5c) failed"
    fi

    # Residual PR1/PR2 canaries when present
    residual=()
    if [[ -f apps/web/tests/approval-form-authoring-history.test.ts ]]; then
      residual+=(tests/approval-form-authoring-history.test.ts)
    fi
    if [[ -f apps/web/tests/approval-version-dual-canvas.test.ts ]]; then
      residual+=(tests/approval-version-dual-canvas.test.ts)
    fi
    if [[ ${#residual[@]} -gt 0 ]]; then
      log "Running residual canaries: ${residual[*]}"
      if pnpm --filter @metasheet/web exec vitest run --watch=false \
        "${residual[@]}" --reporter=dot; then
        ok "residual canaries passed"
      else
        fail "residual canaries failed"
      fi
    else
      ok "residual form-history / dual-canvas tests not present yet (skipped)"
    fi
  fi
fi

log "=== summary failures=${failures} ==="
if [[ "$failures" -ne 0 ]]; then
  log "approval-canvas-owner-uat-smoke: FAIL"
  exit 1
fi
log "approval-canvas-owner-uat-smoke: PASS"
exit 0
