#!/usr/bin/env bash
# W4C-2 QA — run the W4C-2 suites against the isolated QA database, mirroring
# the CI invocation shapes in .github/workflows/plugin-tests.yml:
#   - real-DB suites: step id `attendance-real-db-integration`
#     (vitest --config vitest.integration.config.ts run, whole-file args)
#   - no-DB units:    step `Run core-backend tests` scope, run here as
#     explicit whole files
#   - wiring/collector guards: node --test
# Run from the PR #4612 head checkout root, after qa-db-reset.sh.
set -euo pipefail

DB_NAME="${1:-w4c2_qa}"
PGHOST="${QA_PGHOST:-localhost}"
PGUSER="${QA_PGUSER:-postgres}"

case "$PGHOST" in
  localhost|127.0.0.1) ;;
  *) echo "REFUSED: QA suites only run against localhost/127.0.0.1" >&2; exit 2 ;;
esac
case "$DB_NAME" in
  *w4c2_qa*) ;;
  *) echo "REFUSED: database name must contain 'w4c2_qa'" >&2; exit 2 ;;
esac
if [ ! -f "packages/core-backend/package.json" ]; then
  echo "REFUSED: run from the repo root of the PR #4612 head checkout" >&2
  exit 2
fi

export DATABASE_URL="postgresql://${PGUSER}@${PGHOST}:5432/${DB_NAME}"
export ATTENDANCE_TEST_DATABASE_URL="$DATABASE_URL"

echo "== [1/4] Real-DB W4C-2 suites (CI-shape: whole-file args) =="
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
  tests/integration/attendance-w4c2-timezone-write-guard.db.test.ts \
  tests/integration/attendance-w4c2-outbox-dispatcher.db.test.ts \
  tests/integration/attendance-w4c2-live-scheduled-boundary.db.test.ts \
  tests/integration/attendance-w4c2-posture-matrix.db.test.ts \
  tests/integration/attendance-w4c2-gate-matrix-e5.db.test.ts \
  tests/integration/attendance-w4c2-p2-remediation.db.test.ts \
  tests/integration/attendance-w4c2-p2-1-canonical-freeze-anchor.db.test.ts \
  --reporter=dot

echo "== [2/4] No-DB unit suites (explicit whole files) =="
pnpm --filter @metasheet/core-backend exec vitest run \
  src/attendance/__tests__/w4c2-frozen-attribution.test.ts \
  src/attendance/__tests__/w4c2-shadow-expected-differences.test.ts \
  src/attendance/__tests__/w4c1-segment-calculator.test.ts \
  src/attendance/__tests__/w4c1-fingerprint-golden.test.ts \
  --reporter=dot

echo "== [3/4] Wiring + collector guards (node --test) =="
node --test scripts/ops/attendance-w4c2-ci-wiring.test.mjs
# Collector's byte-reproducibility leg needs the pinned baseline commit object.
git fetch --no-tags --depth=1 origin e0defbe26d7f2e1747e74aa908ca710422812bf7 \
  || git fetch --no-tags origin e0defbe26d7f2e1747e74aa908ca710422812bf7 \
  || echo "WARN: could not fetch pinned baseline commit; collector reproducibility leg may fail"
node --test scripts/ops/attendance-w4c0-dml-inventory-collector.test.mjs

echo "== [4/4] Residue check =="
psql -h "$PGHOST" -U "$PGUSER" -d "$DB_NAME" \
  -v ON_ERROR_STOP=1 -f scripts/attendance/w4c2-qa/qa-residue-check.sql

echo "== W4C-2 QA suite run finished =="
