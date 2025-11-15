#!/bin/bash
# phase4-cleanup-checklist.sh - Phase 4 cleanup verification checklist
# Usage: bash scripts/phase4-cleanup-checklist.sh

set -euo pipefail

echo "🧹 Phase 4 Cleanup Verification Checklist"
echo "=========================================="
echo ""
echo "📅 Check Date: $(date +"%Y-%m-%d %H:%M:%S %Z")"
echo ""

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Counters
PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0

# Check function
check_item() {
  local category="$1"
  local description="$2"
  local command="$3"
  local expected="$4"  # "exists", "not_exists", "empty", "not_empty"

  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "📋 [$category] $description"
  echo ""

  local status="UNKNOWN"
  local result=""

  case "$expected" in
    exists)
      if eval "$command" &>/dev/null; then
        echo -e "${GREEN}✅ PASS${NC}: Item exists as expected"
        status="PASS"
        ((PASS_COUNT++))
      else
        echo -e "${RED}❌ FAIL${NC}: Item does not exist"
        status="FAIL"
        ((FAIL_COUNT++))
      fi
      ;;
    not_exists)
      if ! eval "$command" &>/dev/null; then
        echo -e "${GREEN}✅ PASS${NC}: Item does not exist (cleaned up)"
        status="PASS"
        ((PASS_COUNT++))
      else
        echo -e "${YELLOW}⚠️  WARN${NC}: Item still exists (consider cleanup)"
        status="WARN"
        ((WARN_COUNT++))
      fi
      ;;
    not_empty)
      result=$(eval "$command" 2>/dev/null || echo "")
      if [ -n "$result" ]; then
        echo -e "${GREEN}✅ PASS${NC}: Item is not empty"
        echo "   Result: $result"
        status="PASS"
        ((PASS_COUNT++))
      else
        echo -e "${RED}❌ FAIL${NC}: Item is empty"
        status="FAIL"
        ((FAIL_COUNT++))
      fi
      ;;
    empty)
      result=$(eval "$command" 2>/dev/null || echo "")
      if [ -z "$result" ]; then
        echo -e "${GREEN}✅ PASS${NC}: Item is empty (cleaned up)"
        status="PASS"
        ((PASS_COUNT++))
      else
        echo -e "${YELLOW}⚠️  WARN${NC}: Item is not empty"
        echo "   Found: $result"
        status="WARN"
        ((WARN_COUNT++))
      fi
      ;;
  esac

  echo ""
}

# ============================================================================
# SECTION 1: Documentation Verification
# ============================================================================
echo ""
echo "═══════════════════════════════════════════"
echo "📚 SECTION 1: Documentation Verification"
echo "═══════════════════════════════════════════"
echo ""

check_item "DOCS" \
  "Phase 4 completion report exists" \
  "ls claudedocs/PHASE4_COMPLETION_REPORT*.md" \
  "exists"

check_item "DOCS" \
  "Phase 3 observation report exists" \
  "ls claudedocs/PHASE3_24H_OBSERVATION_REPORT_*.md" \
  "exists"

check_item "DOCS" \
  "Master observability guide exists" \
  "test -f OBSERVABILITY_HARDENING_COMPLETE_GUIDE.md" \
  "exists"

check_item "DOCS" \
  "Obsolete Phase 2 report removed" \
  "! ls claudedocs/*_145113.md 2>/dev/null" \
  "not_exists"

# ============================================================================
# SECTION 2: Artifact Organization
# ============================================================================
echo ""
echo "═══════════════════════════════════════════"
echo "🗂️  SECTION 2: Artifact Organization"
echo "═══════════════════════════════════════════"
echo ""

check_item "ARTIFACTS" \
  "Archive directory exists" \
  "ls -d artifacts/archive/*" \
  "exists"

check_item "ARTIFACTS" \
  "Archived CSV exists" \
  "ls artifacts/archive/*/observability-24h.csv" \
  "exists"

check_item "ARTIFACTS" \
  "Archived summary JSON exists" \
  "ls artifacts/archive/*/observability-24h-summary.json" \
  "exists"

check_item "ARTIFACTS" \
  "Archive manifest exists" \
  "ls artifacts/archive/*/MANIFEST.txt" \
  "exists"

check_item "ARTIFACTS" \
  "Current observation CSV cleaned (optional)" \
  "test ! -f artifacts/observability-24h.csv || test -f artifacts/observability-24h.csv" \
  "exists"

check_item "ARTIFACTS" \
  "Current summary JSON exists" \
  "test -f artifacts/observability-24h-summary.json" \
  "exists"

# ============================================================================
# SECTION 3: Temporary File Cleanup
# ============================================================================
echo ""
echo "═══════════════════════════════════════════"
echo "🗑️  SECTION 3: Temporary File Cleanup"
echo "═══════════════════════════════════════════"
echo ""

check_item "TEMP" \
  "No observation PID file in artifacts/" \
  "test ! -f artifacts/observation.pid" \
  "not_exists"

check_item "TEMP" \
  "No STOP_OBSERVATION file" \
  "test ! -f artifacts/STOP_OBSERVATION" \
  "not_exists"

check_item "TEMP" \
  "No temporary test CSV files" \
  "! ls artifacts/observability-test-*.csv 2>/dev/null" \
  "not_exists"

check_item "TEMP" \
  "No temporary log files" \
  "! ls /tmp/obs_metrics_*.txt 2>/dev/null" \
  "not_exists"

check_item "TEMP" \
  "No leftover .pid files" \
  "! find . -name '*.pid' -type f 2>/dev/null | grep -v node_modules" \
  "not_exists"

# ============================================================================
# SECTION 4: Script Verification
# ============================================================================
echo ""
echo "═══════════════════════════════════════════"
echo "🔧 SECTION 4: Script Verification"
echo "═══════════════════════════════════════════"
echo ""

check_item "SCRIPTS" \
  "observe-24h.sh is executable" \
  "test -x scripts/observe-24h.sh" \
  "exists"

check_item "SCRIPTS" \
  "generate-phase3-report.sh is executable" \
  "test -x scripts/generate-phase3-report.sh" \
  "exists"

check_item "SCRIPTS" \
  "phase3-checkpoint.sh is executable" \
  "test -x scripts/phase3-checkpoint.sh" \
  "exists"

check_item "SCRIPTS" \
  "archive-phase3-data.sh is executable" \
  "test -x scripts/archive-phase3-data.sh" \
  "exists"

check_item "SCRIPTS" \
  "No debug scripts remaining" \
  "! ls scripts/debug*.sh scripts/test*.sh 2>/dev/null" \
  "not_exists"

# ============================================================================
# SECTION 5: CI/CD Configuration
# ============================================================================
echo ""
echo "═══════════════════════════════════════════"
echo "⚙️  SECTION 5: CI/CD Configuration"
echo "═══════════════════════════════════════════"
echo ""

check_item "CI" \
  "v2-observability-strict workflow exists" \
  "test -f .github/workflows/v2-observability-strict.yml" \
  "exists"

check_item "CI" \
  "metrics-lite workflow exists" \
  "test -f .github/workflows/v2-observability-metrics-lite.yml" \
  "exists"

check_item "CI" \
  "No temporary workflow files" \
  "! ls .github/workflows/*-temp.yml .github/workflows/*-backup.yml 2>/dev/null" \
  "not_exists"

check_item "CI" \
  "Branch protection rules snapshot exists" \
  "test -f claudedocs/branch-protection-snapshot.json" \
  "exists"

# ============================================================================
# SECTION 6: Data Integrity
# ============================================================================
echo ""
echo "═══════════════════════════════════════════"
echo "🔍 SECTION 6: Data Integrity"
echo "═══════════════════════════════════════════"
echo ""

check_item "DATA" \
  "Archived CSV has header" \
  "head -1 artifacts/archive/*/observability-24h.csv | grep -q timestamp" \
  "exists"

check_item "DATA" \
  "Archived CSV has data rows" \
  "wc -l < artifacts/archive/*/observability-24h.csv | awk '{exit (\$1 > 2) ? 0 : 1}'" \
  "exists"

check_item "DATA" \
  "Summary JSON is valid" \
  "jq -e '.observation_start' artifacts/archive/*/observability-24h-summary.json" \
  "not_empty"

check_item "DATA" \
  "No duplicate CSV entries" \
  "awk -F, 'NR>1 {print \$1,\$2}' artifacts/archive/*/observability-24h.csv | sort | uniq -d | wc -l | awk '{exit (\$1 == 0) ? 0 : 1}'" \
  "exists"

# ============================================================================
# SECTION 7: Alerts and Monitoring
# ============================================================================
echo ""
echo "═══════════════════════════════════════════"
echo "🚨 SECTION 7: Alerts and Monitoring"
echo "═══════════════════════════════════════════"
echo ""

check_item "ALERTS" \
  "Alerts directory exists" \
  "test -d alerts" \
  "exists"

if [ -f "alerts/observability-critical.txt" ]; then
  check_item "ALERTS" \
    "Critical alerts documented" \
    "test -f alerts/observability-critical.txt && wc -l < alerts/observability-critical.txt" \
    "not_empty"
else
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "📋 [ALERTS] Critical alerts file"
  echo ""
  echo -e "${GREEN}✅ PASS${NC}: No critical alerts (file does not exist)"
  ((PASS_COUNT++))
  echo ""
fi

# ============================================================================
# Summary Report
# ============================================================================
echo ""
echo "═══════════════════════════════════════════"
echo "📊 CLEANUP VERIFICATION SUMMARY"
echo "═══════════════════════════════════════════"
echo ""

TOTAL=$((PASS_COUNT + FAIL_COUNT + WARN_COUNT))

echo "Total Checks: $TOTAL"
echo -e "${GREEN}✅ Passed: $PASS_COUNT${NC}"
echo -e "${RED}❌ Failed: $FAIL_COUNT${NC}"
echo -e "${YELLOW}⚠️  Warnings: $WARN_COUNT${NC}"
echo ""

# Calculate percentage
if [ $TOTAL -gt 0 ]; then
  PASS_PERCENT=$((PASS_COUNT * 100 / TOTAL))
  echo "Success Rate: ${PASS_PERCENT}%"
  echo ""
fi

# Overall status
if [ $FAIL_COUNT -eq 0 ]; then
  echo -e "${GREEN}✨ OVERALL STATUS: PASS${NC}"
  echo ""
  echo "All critical checks passed. Phase 4 cleanup is complete."
  EXIT_CODE=0
else
  echo -e "${RED}❌ OVERALL STATUS: FAIL${NC}"
  echo ""
  echo "Some critical checks failed. Please review and address failures."
  EXIT_CODE=1
fi

# Recommendations
if [ $WARN_COUNT -gt 0 ]; then
  echo ""
  echo "📋 Recommendations:"
  echo "   - Review warning items for potential cleanup"
  echo "   - Warnings do not block Phase 4 completion"
  echo "   - Consider addressing warnings for optimal hygiene"
fi

echo ""
echo "═══════════════════════════════════════════"
echo ""

# Action items
if [ $FAIL_COUNT -gt 0 ] || [ $WARN_COUNT -gt 0 ]; then
  echo "🔧 Next Steps:"

  if [ $FAIL_COUNT -gt 0 ]; then
    echo "   1. Address all FAIL items above"
    echo "   2. Re-run this checklist: bash scripts/phase4-cleanup-checklist.sh"
  fi

  if [ $WARN_COUNT -gt 0 ]; then
    echo "   3. Review WARN items (optional cleanup)"
    echo "   4. Document any intentional exceptions"
  fi
  echo ""
fi

echo "📄 Checklist Log: This output can be saved for audit trail"
echo "   Example: bash scripts/phase4-cleanup-checklist.sh | tee claudedocs/phase4-cleanup-$(date +%Y%m%d).log"
echo ""

exit $EXIT_CODE
