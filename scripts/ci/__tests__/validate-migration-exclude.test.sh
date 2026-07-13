#!/usr/bin/env bash
# Unit test for validate-migration-exclude.sh's drift-detection core (run_checks), the
# testable part. Does NOT scan the real repo (that would make the test hostage to future,
# legitimate edits to the workflows/migration-provider.ts); instead it points the guard at
# small fixture files via the WORKFLOWS_DIR/PROVIDER_FILE overrides and asserts:
#   - a "good" fixture set (mirrors the real, currently-documented baseline + the two known
#     divergences) produces ZERO warnings;
#   - a "drift" fixture set (an undocumented new exclusion, an undocumented divergence, a
#     missing expected overlap item, an undocumented new overlap item, and a missing doc
#     pointer) produces warnings for every one of those distinct cases.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIX="$HERE/../__fixtures__/migration-exclude"
GUARD="$HERE/../validate-migration-exclude.sh"
fail=0

# Runs run_checks() in a subshell against the given fixture subdir (good|drift), so
# WORKFLOWS_DIR/PROVIDER_FILE overrides and WARN_COUNT never leak between runs or into this
# test script's own environment. Writes combined stdout+stderr plus a trailing
# "WARN_COUNT=<n>" line to $2.
run_against() {
  local subdir="$1" outfile="$2"
  (
    WORKFLOWS_DIR="$FIX/$subdir/workflows"
    PROVIDER_FILE="$FIX/$subdir/provider.ts"
    export WORKFLOWS_DIR PROVIDER_FILE
    # shellcheck source=../validate-migration-exclude.sh
    source "$GUARD"
    run_checks
    echo "WARN_COUNT=$WARN_COUNT"
  ) >"$outfile" 2>&1
}

good_out="$(mktemp)"
drift_out="$(mktemp)"
trap 'rm -f "$good_out" "$drift_out"' EXIT

echo "=== good fixture: expect 0 warnings ==="
run_against good "$good_out"
cat "$good_out"
good_warn_count="$(grep -o 'WARN_COUNT=[0-9]*' "$good_out" | tail -1 | cut -d= -f2)"
if [[ "$good_warn_count" == "0" ]]; then
  echo "ok   good fixture: 0 warnings"
else
  echo "FAIL good fixture: expected 0 warnings, got '$good_warn_count'"
  fail=1
fi

echo
echo "=== drift fixture: expect warnings for each injected drift case ==="
run_against drift "$drift_out"
cat "$drift_out"
drift_warn_count="$(grep -o 'WARN_COUNT=[0-9]*' "$drift_out" | tail -1 | cut -d= -f2)"

assert_contains() {
  local label="$1" needle="$2"
  if grep -qF "$needle" "$drift_out"; then
    echo "ok   drift case: $label"
  else
    echo "FAIL drift case: $label (expected to find: $needle)"
    fail=1
  fi
}

if [[ -n "$drift_warn_count" && "$drift_warn_count" -gt 0 ]]; then
  echo "ok   drift fixture: warn count > 0 ($drift_warn_count)"
else
  echo "FAIL drift fixture: expected warn count > 0, got '$drift_warn_count'"
  fail=1
fi

assert_contains "undocumented new exclusion (check A)" "999_bogus_undocumented_migration.sql"
assert_contains "undocumented divergence (check B)" "Undocumented divergence: '042a_core_model_views.sql'"
assert_contains "undocumented overlap (check C)" "999_bogus_undocumented_migration' appears in BOTH"
assert_contains "missing expected overlap item (check C reverse)" "'049_create_bpmn_workflow_tables' is no longer in SUPERSEDED_LEGACY_SQL_MIGRATIONS"
assert_contains "missing doc pointer (check D)" "no longer references docs/development/migration-legacy-sql-skip-design-20260512.md"

echo
[[ "$fail" == "0" ]] && { echo "validate-migration-exclude drift detection: PASS"; exit 0; } || { echo "validate-migration-exclude drift detection: FAIL"; exit 1; }
