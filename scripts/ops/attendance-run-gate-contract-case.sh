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

[[ -n "$CASE_ID" ]] || die "usage: $0 <strict|dashboard|openapi> [output_root]"

info "running zh copy contract guard"
node ./scripts/ops/attendance-verify-zh-copy-contract.mjs

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

if [[ "$CASE_ID" == "openapi" ]]; then
  openapi_dir="${case_dir}/openapi"
  mkdir -p "$openapi_dir"

  info "running openapi build"
  if ! pnpm exec tsx packages/openapi/tools/build.ts >"${openapi_dir}/build.log" 2>&1; then
    cat "${openapi_dir}/build.log" >&2
    die "openapi build failed"
  fi

  if ! git diff --quiet -- \
    packages/openapi/dist/openapi.json \
    packages/openapi/dist/openapi.yaml \
    packages/openapi/dist/combined.openapi.yml; then
    git diff -- \
      packages/openapi/dist/openapi.json \
      packages/openapi/dist/openapi.yaml \
      packages/openapi/dist/combined.openapi.yml >"${openapi_dir}/dist-drift.patch"
    die "openapi dist drift detected; rebuild artifacts and commit generated outputs"
  fi

  node ./scripts/ops/attendance-validate-openapi-import-contract.mjs \
    packages/openapi/dist/openapi.json \
    packages/openapi/src/paths/attendance.yml >"${openapi_dir}/validate.log"

  invalid_openapi="${openapi_dir}/openapi.invalid.json"
  jq 'del(.paths["/api/attendance/import/commit-async"])' \
    packages/openapi/dist/openapi.json >"${invalid_openapi}"
  expect_fail "openapi import path contract" \
    node ./scripts/ops/attendance-validate-openapi-import-contract.mjs \
      "${invalid_openapi}" \
      packages/openapi/src/paths/attendance.yml

  info "OK: openapi contract case passed"
  exit 0
fi

if [[ "$CASE_ID" == "dashboard" ]]; then
  dashboard_valid="${case_dir}/dashboard.valid.json"
  dashboard_invalid_strict="${case_dir}/dashboard.invalid.strict.json"
  dashboard_invalid_perf="${case_dir}/dashboard.invalid.perf.json"
  dashboard_invalid_longrun="${case_dir}/dashboard.invalid.longrun.json"
  dashboard_invalid_upsert="${case_dir}/dashboard.invalid.upsert.json"

  cat >"$dashboard_valid" <<'EOF'
{
  "p0Status": "pass",
  "overallStatus": "pass",
  "gates": {
    "strict": {
      "completed": {
        "id": 200001,
        "conclusion": "success"
      }
    },
    "perf": {
      "completed": {
        "id": 200002,
        "conclusion": "success"
      }
    },
    "longrun": {
      "completed": {
        "id": 200003,
        "conclusion": "success"
      }
    },
    "localeZh": {
      "completed": {
        "id": 200004,
        "conclusion": "success"
      }
    }
  },
  "gateFlat": {
    "schemaVersion": 2,
    "strict": {
      "summaryPresent": true,
      "summaryValid": true
    },
    "perf": {
      "status": "PASS",
      "reasonCode": null,
      "runId": 200002,
      "summarySchemaVersion": 2,
      "scenario": "100000-commit",
      "rows": 100000,
      "mode": "commit",
      "uploadCsv": "true",
      "recordUpsertStrategy": "staging",
      "expectedRecordUpsertStrategy": "staging",
      "previewMs": "1200",
      "regressionsCount": "0"
    },
    "longrun": {
      "status": "PASS",
      "reasonCode": null,
      "runId": 200003,
      "summarySchemaVersion": 2,
      "scenario": "rows500k-preview",
      "rows": 500000,
      "mode": "preview",
      "uploadCsv": "true",
      "recordUpsertStrategy": "values",
      "expectedRecordUpsertStrategy": "values",
      "previewMs": "33000",
      "regressionsCount": "0"
    },
    "localeZh": {
      "status": "PASS",
      "reasonCode": null,
      "runId": 200004
    }
  },
  "escalationIssue": {
    "mode": "none_or_closed",
    "p0Status": "pass"
  }
}
EOF

  cat >"$dashboard_invalid_upsert" <<'EOF'
{
  "p0Status": "pass",
  "overallStatus": "pass",
  "gates": {
    "strict": {
      "completed": {
        "id": 600001,
        "conclusion": "success"
      }
    },
    "perf": {
      "completed": {
        "id": 600002,
        "conclusion": "success"
      }
    },
    "longrun": {
      "completed": {
        "id": 600003,
        "conclusion": "success"
      }
    },
    "localeZh": {
      "completed": {
        "id": 600004,
        "conclusion": "success"
      }
    }
  },
  "gateFlat": {
    "schemaVersion": 2,
    "strict": {
      "summaryPresent": true,
      "summaryValid": true
    },
    "perf": {
      "status": "PASS",
      "reasonCode": null,
      "runId": 600002,
      "summarySchemaVersion": 2,
      "scenario": "100000-commit",
      "rows": 100000,
      "mode": "commit",
      "uploadCsv": "true",
      "recordUpsertStrategy": "staging",
      "expectedRecordUpsertStrategy": "values",
      "previewMs": "1200",
      "regressionsCount": "0"
    },
    "longrun": {
      "status": "PASS",
      "reasonCode": null,
      "runId": 600003,
      "summarySchemaVersion": 2,
      "scenario": "rows500k-preview",
      "rows": 500000,
      "mode": "preview",
      "uploadCsv": "true",
      "recordUpsertStrategy": "staging",
      "expectedRecordUpsertStrategy": "staging",
      "previewMs": "33000",
      "regressionsCount": "0"
    },
    "localeZh": {
      "status": "PASS",
      "reasonCode": null,
      "runId": 600004
    }
  },
  "escalationIssue": {
    "mode": "none_or_closed",
    "p0Status": "pass"
  }
}
EOF

  cat >"$dashboard_invalid_strict" <<'EOF'
{
  "p0Status": "fail",
  "overallStatus": "fail",
  "gates": {
    "strict": {
      "completed": {
        "id": 300001,
        "conclusion": "success"
      }
    },
    "perf": {
      "completed": {
        "id": 300002,
        "conclusion": "success"
      }
    },
    "longrun": {
      "completed": {
        "id": 300003,
        "conclusion": "success"
      }
    },
    "localeZh": {
      "completed": {
        "id": 300004,
        "conclusion": "success"
      }
    }
  },
  "gateFlat": {
    "schemaVersion": 2,
    "strict": {
      "summaryPresent": true,
      "summaryValid": false
    },
    "perf": {
      "status": "PASS",
      "runId": 300002,
      "summarySchemaVersion": 2,
      "scenario": "100000-commit",
      "rows": 100000,
      "mode": "commit",
      "uploadCsv": "true",
      "previewMs": "1200",
      "regressionsCount": "0"
    },
    "longrun": {
      "status": "PASS",
      "runId": 300003,
      "summarySchemaVersion": 2,
      "scenario": "rows500k-preview",
      "rows": 500000,
      "mode": "preview",
      "uploadCsv": "true",
      "previewMs": "33000",
      "regressionsCount": "0"
    },
    "localeZh": {
      "status": "PASS",
      "reasonCode": null,
      "runId": 300004
    }
  },
  "escalationIssue": {
    "mode": "open",
    "p0Status": "fail"
  }
}
EOF

  cat >"$dashboard_invalid_perf" <<'EOF'
{
  "p0Status": "pass",
  "overallStatus": "pass",
  "gates": {
    "strict": {
      "completed": {
        "id": 400001,
        "conclusion": "success"
      }
    },
    "perf": {
      "completed": {
        "id": 400002,
        "conclusion": "success"
      }
    },
    "longrun": {
      "completed": {
        "id": 400003,
        "conclusion": "success"
      }
    },
    "localeZh": {
      "completed": {
        "id": 400004,
        "conclusion": "success"
      }
    }
  },
  "gateFlat": {
    "schemaVersion": 2,
    "strict": {
      "summaryPresent": true,
      "summaryValid": true
    },
    "perf": {
      "status": "PASS",
      "reasonCode": null,
      "runId": 400002,
      "summarySchemaVersion": 1,
      "scenario": "100000-commit",
      "rows": 100000,
      "mode": "commit",
      "uploadCsv": "true",
      "previewMs": "1200",
      "regressionsCount": "0"
    },
    "longrun": {
      "status": "PASS",
      "reasonCode": null,
      "runId": 400003,
      "summarySchemaVersion": 2,
      "scenario": "rows500k-preview",
      "rows": 500000,
      "mode": "preview",
      "uploadCsv": "true",
      "previewMs": "33000",
      "regressionsCount": "0"
    },
    "localeZh": {
      "status": "PASS",
      "reasonCode": null,
      "runId": 400004
    }
  },
  "escalationIssue": {
    "mode": "none_or_closed",
    "p0Status": "pass"
  }
}
EOF

  cat >"$dashboard_invalid_longrun" <<'EOF'
{
  "p0Status": "pass",
  "overallStatus": "pass",
  "gates": {
    "strict": {
      "completed": {
        "id": 500001,
        "conclusion": "success"
      }
    },
    "perf": {
      "completed": {
        "id": 500002,
        "conclusion": "success"
      }
    },
    "longrun": {
      "completed": {
        "id": 500003,
        "conclusion": "success"
      }
    },
    "localeZh": {
      "completed": {
        "id": 500004,
        "conclusion": "success"
      }
    }
  },
  "gateFlat": {
    "schemaVersion": 2,
    "strict": {
      "summaryPresent": true,
      "summaryValid": true
    },
    "perf": {
      "status": "PASS",
      "reasonCode": null,
      "runId": 500002,
      "summarySchemaVersion": 2,
      "scenario": "100000-commit",
      "rows": 100000,
      "mode": "commit",
      "uploadCsv": "true",
      "previewMs": "1200",
      "regressionsCount": "0"
    },
    "longrun": {
      "status": "PASS",
      "reasonCode": null,
      "runId": 500003,
      "summarySchemaVersion": 2,
      "scenario": "rows500k-preview",
      "rows": 500000,
      "mode": "preview",
      "uploadCsv": "maybe",
      "previewMs": "33000",
      "regressionsCount": "0"
    },
    "localeZh": {
      "status": "PASS",
      "reasonCode": null,
      "runId": 500004
    }
  },
  "escalationIssue": {
    "mode": "none_or_closed",
    "p0Status": "pass"
  }
}
EOF

  ./scripts/ops/attendance-validate-daily-dashboard-json.sh "$dashboard_valid"
  expect_fail "dashboard strict-summary-validity contract" \
    ./scripts/ops/attendance-validate-daily-dashboard-json.sh "$dashboard_invalid_strict"
  expect_fail "dashboard perf gateFlat contract" \
    ./scripts/ops/attendance-validate-daily-dashboard-json.sh "$dashboard_invalid_perf"
  expect_fail "dashboard longrun gateFlat contract" \
    ./scripts/ops/attendance-validate-daily-dashboard-json.sh "$dashboard_invalid_longrun"
  expect_fail "dashboard upsert contract" \
    ./scripts/ops/attendance-validate-daily-dashboard-json.sh "$dashboard_invalid_upsert"

  info "OK: dashboard contract case passed"
  exit 0
fi

die "unsupported case: ${CASE_ID}"
