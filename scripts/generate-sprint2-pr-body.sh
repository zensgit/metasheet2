#!/usr/bin/env bash
set -euo pipefail

OUT="docs/sprint2/pr-description-draft.md"
PERF_DIR="docs/sprint2/performance"
EVID_DIR="docs/sprint2/evidence"

latest_summary=$(ls -t "$PERF_DIR"/*.summary.json 2>/dev/null | head -n1 || true)

perf_section="No performance summary yet. Run staging:perf."
if [[ -n "$latest_summary" ]]; then
  summary=$(cat "$latest_summary")
  p50=$(jq -r '.p50' <<< "$summary" 2>/dev/null || python3 - << 'PY' "$summary"
import json,sys; d=json.loads(sys.argv[1]); print(d.get('p50',''))
PY
)
  p95=$(jq -r '.p95' <<< "$summary" 2>/dev/null || python3 - << 'PY' "$summary"
import json,sys; d=json.loads(sys.argv[1]); print(d.get('p95',''))
PY
)
  p99=$(jq -r '.p99' <<< "$summary" 2>/dev/null || python3 - << 'PY' "$summary"
import json,sys; d=json.loads(sys.argv[1]); print(d.get('p99',''))
PY
)
  max=$(jq -r '.max' <<< "$summary" 2>/dev/null || python3 - << 'PY' "$summary"
import json,sys; d=json.loads(sys.argv[1]); print(d.get('max',''))
PY
)
  errors=$(jq -r '.errors' <<< "$summary" 2>/dev/null || python3 - << 'PY' "$summary"
import json,sys; d=json.loads(sys.argv[1]); print(d.get('errors',''))
PY
)
  total=$(jq -r '.total' <<< "$summary" 2>/dev/null || python3 - << 'PY' "$summary"
import json,sys; d=json.loads(sys.argv[1]); print(d.get('total',''))
PY
)
  perf_section=$(cat <<EOF
### Performance Summary
- Samples: $total  |  Errors: $errors
- P50: ${p50} ms  |  P95: ${p95} ms  |  P99: ${p99} ms  |  Max: ${max} ms
- Artifact: \
  \
  \
  ${latest_summary}
EOF
)
fi

evidence_list=$(ls -t "$EVID_DIR"/* 2>/dev/null | head -n 10 | sed 's/^/- /' || echo "- (no evidence yet)")

cat > "$OUT" << EOF
# PR: Sprint 2 — Snapshot Protection System (Staging Validation)

## Overview
- Introduces Snapshot Protection: labels, protection levels, release channels
- Adds Protection Rules admin APIs with dry-run evaluation

## Validation Summary
- Local: PASSED — see docs/sprint2/local-validation-report.md
- Staging: In Progress — see docs/sprint2/staging-validation-report.md

$perf_section

## Evidence (latest)
$evidence_list

## Risks & Mitigations
- Rule precedence and effect conflicts — precedence documented
- Idempotency & rate limiting — validated in staging scripts
- Audit trail linkage — rule_execution_log checked

## Follow-ups
- Fill staging report with final results and attach screenshots

EOF

echo "Updated PR description draft -> $OUT"

