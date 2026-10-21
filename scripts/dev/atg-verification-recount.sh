#!/usr/bin/env bash
# atg-verification-recount.sh
#
# Mechanical recount for docs/development/approval-template-groups-phase1-verification-20260918.md
# §14 "三线共用 #4" (error codes must not degrade to a bare HTTP status).
#
# WHY THIS EXISTS: the same machine-countable numbers in that table row have gone stale
# THREE times (修复轮 1, 修复轮 5, and impl-gate-A-slice1-round4-20260918.md §2 P2-2) because
# a new it() or a new error.code assertion was added to one of the two test files and the row
# was not re-run. This script is the machine-countable half of the fix: run it after ANY
# addition/removal of an it() or an error.code assertion in either file, and paste its output
# back into §14 verbatim (do not hand-edit the numbers).
#
# Usage:
#   scripts/dev/atg-verification-recount.sh
#
# Exit code is always 0 (this is a reporting tool, not a gate); read the printed numbers.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_DIR="$REPO_ROOT/packages/core-backend/tests/integration"
LIFECYCLE="approval-template-groups-lifecycle.db.test.ts"
SERIALIZATION="approval-template-groups-serialization.db.test.ts"

cd "$TEST_DIR"

for f in "$LIFECYCLE" "$SERIALIZATION"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: expected test file not found: $TEST_DIR/$f" >&2
    exit 1
  fi
done

echo "=== command 1: negative status assertions (.status).toBe(4xx|500)) across both files ==="
echo '$ grep -noE "\.status\)\.toBe\((40[0-9]|500)\)" '"$LIFECYCLE $SERIALIZATION"' | wc -l'
STATUS_COUNT=$(grep -noE "\.status\)\.toBe\((40[0-9]|500)\)" "$LIFECYCLE" "$SERIALIZATION" | wc -l | tr -d ' ')
echo "$STATUS_COUNT"
echo

echo "=== command 2: paired error.code assertions across both files ==="
echo '$ grep -noE "error\.code\)\.toBe\('"'"'[A-Z_]+'"'"'\)" '"$LIFECYCLE $SERIALIZATION"' | wc -l'
CODE_COUNT=$(grep -noE "error\.code\)\.toBe\('[A-Z_]+'\)" "$LIFECYCLE" "$SERIALIZATION" | wc -l | tr -d ' ')
echo "$CODE_COUNT"
echo

echo "=== derived: difference (bare-403 assertions not paired with a code) ==="
echo "$((STATUS_COUNT - CODE_COUNT))"
echo

echo "=== command 3: every toBe(403) line number in $LIFECYCLE ==="
echo '$ grep -n "toBe(403)" '"$LIFECYCLE"
grep -n "toBe(403)" "$LIFECYCLE"
echo

echo "=== per-code breakdown: every error.code).toBe('CODE') hit, both files, with line numbers ==="
grep -noE "error\.code\)\.toBe\('[A-Z_]+'\)" "$LIFECYCLE" "$SERIALIZATION"
echo

echo "=== per-code counts (sorted, most-frequent first) ==="
grep -hoE "error\.code\)\.toBe\('[A-Z_]+'\)" "$LIFECYCLE" "$SERIALIZATION" | grep -oE "'[A-Z_]+'" | sort | uniq -c | sort -rn
echo

echo "=== off-table code check: APPROVAL_TEMPLATE_NOT_FOUND (reused, not one of design MD §3.3's ratified codes) ==="
grep -n -F "error.code).toBe('APPROVAL_TEMPLATE_NOT_FOUND')" "$LIFECYCLE" "$SERIALIZATION" || true
echo

cat <<'EOF'
=== how to use this output ===
1. STATUS_COUNT / CODE_COUNT / their difference -> §14 三线共用 #4's "共 N 处" / "共 N 处" / "差额 N 处" numbers.
2. The toBe(403) line list -> the "F 用例" line-number citation (last line is usually the
   A'''(iii) noTenantRes 403, paired with SESSION_ORG_REQUIRED, NOT part of the F-block diff).
3. The per-code counts -> the "逐码核对" list. Any code present in this output but NOT in
   design MD §3.3's error-code table is a NEW code this round — call it out by name (see
   P3-1 in impl-gate-A-slice1-round4-20260918.md for the convention) and update the design MD
   table separately; do not silently fold it into the existing 10/9 (or whatever the current
   denominator is) without updating the fraction.
4. APPROVAL_TEMPLATE_NOT_FOUND is intentionally off-table (a link-visibility 404 reusing an
   existing code, not a ratified template-groups code) — track it in its own sentence, not in
   the N/M in-table fraction.
EOF
