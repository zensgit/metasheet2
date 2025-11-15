#!/bin/bash
# phase4-verify-artifacts.sh
# 验证 Phase 4 所有产出物完整性

set -euo pipefail

# ============================================
# Configuration
# ============================================
REQUIRED_FILES=(
  "artifacts/observability-24h.csv"
  "artifacts/observability-24h-summary.json"
  "artifacts/observe-24h.log"
  "claudedocs/PHASE4_COMPLETION_REPORT_DRAFT_20251112_153414.md"
  "claudedocs/PHASE4_EXECUTION_CHECKLIST.md"
  "claudedocs/PHASE4_PR_MERGE_DESCRIPTION.md"
  "claudedocs/PHASE4_POST_DEPLOYMENT_OPTIMIZATIONS.md"
  "scripts/observe-24h.sh"
  "scripts/generate-phase3-report.sh"
  "scripts/archive-phase3-data.sh"
  "scripts/phase4-cleanup-checklist.sh"
)

CHECKPOINT_FILES=(
  "artifacts/checkpoint_T+2h.out"
  "artifacts/checkpoint_T+12h.out"
)

# ============================================
# Colors
# ============================================
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# ============================================
# Counters
# ============================================
TOTAL_CHECKS=0
PASSED_CHECKS=0
FAILED_CHECKS=0
WARNINGS=0

# ============================================
# Helper Functions
# ============================================
check_pass() {
  echo -e "${GREEN}✓${NC} $1"
  ((PASSED_CHECKS++))
  ((TOTAL_CHECKS++))
}

check_fail() {
  echo -e "${RED}✗${NC} $1"
  ((FAILED_CHECKS++))
  ((TOTAL_CHECKS++))
}

check_warn() {
  echo -e "${YELLOW}⚠${NC} $1"
  ((WARNINGS++))
  ((TOTAL_CHECKS++))
}

# ============================================
# Main Verification
# ============================================
echo "=== Phase 4 Artifacts Verification ==="
echo "Timestamp: $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo ""

# ============================================
# 1. Check Required Files
# ============================================
echo "📂 Checking Required Files..."
for file in "${REQUIRED_FILES[@]}"; do
  if [ -f "$file" ]; then
    check_pass "Required file exists: $file"
  else
    check_fail "Missing required file: $file"
  fi
done
echo ""

# ============================================
# 2. Check Checkpoint Files
# ============================================
echo "🕐 Checking Checkpoint Files..."
for file in "${CHECKPOINT_FILES[@]}"; do
  if [ -f "$file" ]; then
    check_pass "Checkpoint file exists: $file"
  else
    check_warn "Checkpoint file not found: $file (may not have executed yet)"
  fi
done
echo ""

# ============================================
# 3. Verify Observation Status
# ============================================
echo "📊 Verifying Observation Status..."
if [ -f "artifacts/observability-24h-summary.json" ]; then
  STATUS=$(jq -r '.status' artifacts/observability-24h-summary.json 2>/dev/null || echo "unknown")
  SAMPLES=$(jq -r '.samples_collected' artifacts/observability-24h-summary.json 2>/dev/null || echo "0")

  if [ "$STATUS" = "completed" ]; then
    check_pass "Observation status: $STATUS"
  elif [ "$STATUS" = "running" ]; then
    check_warn "Observation status: $STATUS (not yet completed)"
  else
    check_warn "Observation status: $STATUS"
  fi

  if [ "$SAMPLES" -ge 48 ]; then
    check_pass "Samples collected: $SAMPLES / 48"
  else
    check_warn "Samples collected: $SAMPLES / 48 (incomplete)"
  fi
else
  check_fail "Cannot read observability-24h-summary.json"
fi
echo ""

# ============================================
# 4. Check Archive Integrity
# ============================================
echo "📦 Checking Archive Integrity..."
ARCHIVE_DIRS=$(find artifacts/archive -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)

if [ "$ARCHIVE_DIRS" -gt 0 ]; then
  LATEST_ARCHIVE=$(find artifacts/archive -mindepth 1 -maxdepth 1 -type d | sort -r | head -1)
  check_pass "Archive directory found: $LATEST_ARCHIVE"

  # Check MANIFEST
  if [ -f "$LATEST_ARCHIVE/MANIFEST.txt" ]; then
    check_pass "MANIFEST.txt exists in archive"
  else
    check_fail "MANIFEST.txt missing in archive"
  fi

  # Check archived files
  REQUIRED_ARCHIVE_FILES=("observability-24h.csv" "observability-24h-summary.json" "observe-24h.log")
  for file in "${REQUIRED_ARCHIVE_FILES[@]}"; do
    if [ -f "$LATEST_ARCHIVE/$file" ]; then
      check_pass "Archived file exists: $file"
    else
      check_fail "Archived file missing: $file"
    fi
  done
else
  check_warn "No archive directory found (archival may not have run yet)"
fi
echo ""

# ============================================
# 5. Check Report Generation
# ============================================
echo "📝 Checking Report Generation..."
PHASE3_REPORTS=$(find claudedocs -name "PHASE3_24H_OBSERVATION_REPORT_*.md" 2>/dev/null | wc -l)

if [ "$PHASE3_REPORTS" -gt 0 ]; then
  LATEST_REPORT=$(find claudedocs -name "PHASE3_24H_OBSERVATION_REPORT_*.md" | sort -r | head -1)
  check_pass "Phase 3 observation report generated: $LATEST_REPORT"
else
  check_warn "Phase 3 observation report not found (may not have been generated yet)"
fi
echo ""

# ============================================
# 6. Verify Metrics Filling
# ============================================
echo "🔢 Verifying Metrics Filling..."
if [ -f "claudedocs/PHASE4_COMPLETION_REPORT_DRAFT_20251112_153414.md" ]; then
  UNFILLED_COUNT=$(grep -c "\[AUTO-FILL" claudedocs/PHASE4_COMPLETION_REPORT_DRAFT_20251112_153414.md || echo 0)

  if [ "$UNFILLED_COUNT" -eq 0 ]; then
    check_pass "All AUTO-FILL fields have been filled"
  else
    check_warn "Found $UNFILLED_COUNT unfilled AUTO-FILL fields"
  fi
else
  check_fail "Completion report draft not found"
fi
echo ""

# ============================================
# 7. Check Cleanup Execution
# ============================================
echo "🧹 Checking Cleanup Execution..."
if [ -f "scripts/phase4-cleanup-checklist.sh" ]; then
  if [ -x "scripts/phase4-cleanup-checklist.sh" ]; then
    check_pass "Cleanup checklist script is executable"

    # Try to run it (capture output)
    CLEANUP_OUTPUT=$(bash scripts/phase4-cleanup-checklist.sh 2>&1 || echo "FAILED")
    if echo "$CLEANUP_OUTPUT" | grep -q "All checks PASS"; then
      check_pass "Cleanup checklist: All checks PASS"
    elif echo "$CLEANUP_OUTPUT" | grep -q "FAILED"; then
      check_fail "Cleanup checklist execution failed"
    else
      check_warn "Cleanup checklist: Some checks may have failed"
    fi
  else
    check_warn "Cleanup checklist script not executable"
  fi
else
  check_fail "Cleanup checklist script not found"
fi
echo ""

# ============================================
# 8. Check Observation Process
# ============================================
echo "🔄 Checking Observation Process..."
if ps -p 30986 > /dev/null 2>&1; then
  check_warn "Observation process (PID 30986) still running"
else
  check_pass "Observation process (PID 30986) completed"
fi

if ps -p 95504 > /dev/null 2>&1; then
  check_warn "Auto-cleanup watcher (PID 95504) still running"
else
  check_pass "Auto-cleanup watcher (PID 95504) completed or terminated"
fi
echo ""

# ============================================
# 9. Check Issue Drafts
# ============================================
echo "📋 Checking Issue Drafts..."
ISSUE_DRAFTS=(
  "claudedocs/ISSUE_DRAFT_MULTI_SOURCE_VALIDATION.md"
  "claudedocs/ISSUE_DRAFT_ROLLING_TREND_ANALYSIS.md"
  "claudedocs/ISSUE_DRAFT_ARCHIVE_DRY_RUN.md"
)

for draft in "${ISSUE_DRAFTS[@]}"; do
  if [ -f "$draft" ]; then
    check_pass "Issue draft exists: $(basename $draft)"
  else
    check_fail "Issue draft missing: $(basename $draft)"
  fi
done
echo ""

# ============================================
# 10. Check Master Guide Update
# ============================================
echo "📖 Checking Master Guide Update..."
if [ -f "claudedocs/OBSERVABILITY_HARDENING_COMPLETE_GUIDE.md" ]; then
  if grep -q "📍 ANCHOR POINT: 24h观察完成后在此粘贴执行摘要" claudedocs/OBSERVABILITY_HARDENING_COMPLETE_GUIDE.md; then
    check_pass "Master guide anchor point exists"
  else
    check_warn "Master guide anchor point not found"
  fi
else
  check_fail "Master guide not found"
fi
echo ""

# ============================================
# Summary
# ============================================
echo "=========================================="
echo "Verification Summary"
echo "=========================================="
echo -e "Total Checks:  $TOTAL_CHECKS"
echo -e "${GREEN}Passed:        $PASSED_CHECKS${NC}"
echo -e "${RED}Failed:        $FAILED_CHECKS${NC}"
echo -e "${YELLOW}Warnings:      $WARNINGS${NC}"
echo ""

if [ $FAILED_CHECKS -eq 0 ]; then
  echo -e "${GREEN}✅ All critical checks PASSED${NC}"
  if [ $WARNINGS -gt 0 ]; then
    echo -e "${YELLOW}⚠️  There are $WARNINGS warnings (non-critical)${NC}"
  fi
  exit 0
else
  echo -e "${RED}❌ $FAILED_CHECKS critical checks FAILED${NC}"
  echo ""
  echo "Please address the failures before proceeding with PR creation."
  exit 1
fi
