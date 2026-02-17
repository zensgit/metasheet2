#!/usr/bin/env bash
set -euo pipefail

CASE_ID="${1:-}"
OUTPUT_ROOT="${2:-output/playwright/attendance-gate-contract-matrix}"

function die() {
  echo "[attendance-run-gate-contract-case] ERROR: $*" >&2
  exit 1
}

function info() {
  echo "[attendance-run-gate-contract-case] $*" >&2
}

[[ -n "$CASE_ID" ]] || die "usage: $0 <strict|dashboard> [output_root]"

case_dir="${OUTPUT_ROOT}/${CASE_ID}"
mkdir -p "$case_dir"

strict_dir="${case_dir}/strict"
mkdir -p "$strict_dir"

valid_summary="${strict_dir}/gate-summary.valid.json"
invalid_summary="${strict_dir}/gate-summary.invalid.json"

cat >"$valid_summary" <<'EOF'
{
  "schemaVersion": 1,
  "generatedAt": "2026-02-17T00:00:00Z",
  "apiBase": "http://example.test/api",
  "webUrl": "http://example.test/attendance",
  "expectProductMode": "attendance",
  "exitCode": 0,
  "gates": {
    "preflight": "SKIP",
    "apiSmoke": "PASS",
    "provisioning": "PASS",
    "playwrightProd": "PASS",
    "playwrightDesktop": "PASS",
    "playwrightMobile": "PASS"
  },
  "gateReasons": {
    "apiSmoke": null,
    "provisioning": null,
    "playwrightProd": null,
    "playwrightDesktop": null,
    "playwrightMobile": null
  }
}
EOF

cat >"$invalid_summary" <<'EOF'
{
  "schemaVersion": 1,
  "generatedAt": "2026-02-17T00:00:00Z",
  "apiBase": "http://example.test/api",
  "webUrl": "http://example.test/attendance",
  "expectProductMode": "attendance",
  "exitCode": 1,
  "gates": {
    "preflight": "SKIP",
    "apiSmoke": "BROKEN",
    "provisioning": "SKIP",
    "playwrightProd": "SKIP",
    "playwrightDesktop": "SKIP",
    "playwrightMobile": "SKIP"
  },
  "gateReasons": {
    "apiSmoke": "AUTH_FAILED",
    "provisioning": null,
    "playwrightProd": null,
    "playwrightDesktop": null,
    "playwrightMobile": null
  }
}
EOF

function expect_fail() {
  local label="$1"
  shift
  if "$@"; then
    die "expected failure did not occur: ${label}"
  fi
  info "expected failure confirmed: ${label}"
}

if [[ "$CASE_ID" == "strict" ]]; then
  cp "$valid_summary" "${strict_dir}/gate-summary.json"
  ./scripts/ops/attendance-validate-gate-summary.sh "$strict_dir" 1
  node ./scripts/ops/attendance-validate-gate-summary-schema.mjs \
    "$strict_dir" \
    1 \
    schemas/attendance/strict-gate-summary.schema.json

  cp "$invalid_summary" "${strict_dir}/gate-summary.json"
  expect_fail "strict jq contract (invalid summary)" \
    ./scripts/ops/attendance-validate-gate-summary.sh "$strict_dir" 1
  expect_fail "strict json schema contract (invalid summary)" \
    node ./scripts/ops/attendance-validate-gate-summary-schema.mjs \
      "$strict_dir" \
      1 \
      schemas/attendance/strict-gate-summary.schema.json

  info "OK: strict contract case passed"
  exit 0
fi

if [[ "$CASE_ID" == "dashboard" ]]; then
  dashboard_valid="${case_dir}/dashboard.valid.json"
  dashboard_invalid="${case_dir}/dashboard.invalid.json"

  cat >"$dashboard_valid" <<'EOF'
{
  "p0Status": "pass",
  "overallStatus": "pass",
  "gates": {
    "strict": {
      "completed": {
        "conclusion": "success"
      }
    }
  },
  "gateFlat": {
    "schemaVersion": 2,
    "strict": {
      "summaryPresent": true,
      "summaryValid": true
    }
  },
  "escalationIssue": {
    "mode": "none_or_closed",
    "p0Status": "pass"
  }
}
EOF

  cat >"$dashboard_invalid" <<'EOF'
{
  "p0Status": "fail",
  "overallStatus": "fail",
  "gates": {
    "strict": {
      "completed": {
        "conclusion": "success"
      }
    }
  },
  "gateFlat": {
    "schemaVersion": 2,
    "strict": {
      "summaryPresent": true,
      "summaryValid": false
    }
  },
  "escalationIssue": {
    "mode": "open",
    "p0Status": "fail"
  }
}
EOF

  ./scripts/ops/attendance-validate-daily-dashboard-json.sh "$dashboard_valid"
  expect_fail "dashboard strict-summary-validity contract" \
    ./scripts/ops/attendance-validate-daily-dashboard-json.sh "$dashboard_invalid"

  info "OK: dashboard contract case passed"
  exit 0
fi

die "unsupported case: ${CASE_ID}"
