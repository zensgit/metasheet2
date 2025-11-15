#!/bin/bash
# phase4-preflight-check.sh
# Preflight检查：验证环境就绪，工具链完整

set -euo pipefail

# ============================================
# Environment Setup
# ============================================
# Locale stability (consistent sorting/formatting)
export LC_ALL=C
export TZ=UTC

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Counters
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
# Preflight Checks
# ============================================
echo "=== Phase 4 Preflight Check ==="
echo "Timestamp: $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "Locale: LC_ALL=$LC_ALL, TZ=$TZ"
echo ""

# ============================================
# 1. Toolchain Sanity
# ============================================
echo "🔧 Checking Toolchain..."

# gh CLI
if command -v gh &> /dev/null; then
  GH_VERSION=$(gh --version | head -1)
  check_pass "gh CLI installed: $GH_VERSION"

  # Check authentication
  if gh auth status &> /dev/null; then
    check_pass "gh authentication: logged in"
  else
    check_fail "gh authentication: NOT logged in (run: gh auth login)"
  fi
else
  check_fail "gh CLI not found (install: brew install gh)"
fi

# jq
if command -v jq &> /dev/null; then
  JQ_VERSION=$(jq --version)
  check_pass "jq installed: $JQ_VERSION"
else
  check_fail "jq not found (install: brew install jq)"
fi

# awk (should be built-in)
if command -v awk &> /dev/null; then
  check_pass "awk available"
else
  check_fail "awk not found (required)"
fi

# sed (should be built-in)
if command -v sed &> /dev/null; then
  check_pass "sed available"
else
  check_fail "sed not found (required)"
fi

# bc (for floating point comparison)
if command -v bc &> /dev/null; then
  check_pass "bc available"
else
  check_warn "bc not found (optional, used for threshold checks)"
fi

# git
if command -v git &> /dev/null; then
  GIT_VERSION=$(git --version)
  check_pass "git installed: $GIT_VERSION"
else
  check_fail "git not found (required)"
fi

echo ""

# ============================================
# 2. Git Repository Status
# ============================================
echo "📂 Checking Git Repository..."

if git rev-parse --git-dir > /dev/null 2>&1; then
  check_pass "Git repository detected"

  # Current branch
  CURRENT_BRANCH=$(git branch --show-current)
  check_pass "Current branch: $CURRENT_BRANCH"

  # Check for uncommitted changes
  if git diff-index --quiet HEAD --; then
    check_pass "Working directory clean"
  else
    check_warn "Working directory has uncommitted changes"
    git status --short | head -5
  fi

  # Check remote
  if git remote -v | grep -q "origin"; then
    check_pass "Remote 'origin' configured"
  else
    check_warn "Remote 'origin' not found"
  fi
else
  check_fail "Not in a git repository"
fi

echo ""

# ============================================
# 3. Phase 3 Observation Status
# ============================================
echo "⏱️  Checking Phase 3 Observation Status..."

if [ -f "artifacts/observability-24h-summary.json" ]; then
  OBS_STATUS=$(jq -r '.status' artifacts/observability-24h-summary.json 2>/dev/null || echo "unknown")
  SAMPLES=$(jq -r '.samples_collected' artifacts/observability-24h-summary.json 2>/dev/null || echo "0")

  if [ "$OBS_STATUS" = "running" ]; then
    check_pass "Observation status: $OBS_STATUS"
    check_pass "Samples collected: $SAMPLES / 48"
  elif [ "$OBS_STATUS" = "completed" ]; then
    check_pass "Observation status: $OBS_STATUS (ready for Phase 4)"
    check_pass "Samples collected: $SAMPLES / 48"
  else
    check_warn "Observation status: $OBS_STATUS"
  fi
else
  check_fail "observability-24h-summary.json not found"
fi

# Check observation process
if ps -p 30986 > /dev/null 2>&1; then
  check_pass "Observation process (PID 30986) running"
else
  check_warn "Observation process (PID 30986) not running (may have completed)"
fi

echo ""

# ============================================
# 4. Required Files Existence
# ============================================
echo "📄 Checking Required Files..."

REQUIRED_FILES=(
  "scripts/phase4-fill-final-metrics.sh"
  "scripts/phase4-verify-artifacts.sh"
  "scripts/generate-phase3-report.sh"
  "scripts/archive-phase3-data.sh"
  "scripts/phase4-cleanup-checklist.sh"
  "claudedocs/PHASE4_COMPLETION_REPORT_DRAFT_20251112_153414.md"
  "claudedocs/PHASE4_PR_MERGE_DESCRIPTION.md"
  "claudedocs/PHASE4_EXECUTION_CHECKLIST.md"
)

for file in "${REQUIRED_FILES[@]}"; do
  if [ -f "$file" ]; then
    # Check if script is executable
    if [[ "$file" == scripts/*.sh ]]; then
      if [ -x "$file" ]; then
        check_pass "$file exists and is executable"
      else
        check_warn "$file exists but not executable (run: chmod +x $file)"
      fi
    else
      check_pass "$file exists"
    fi
  else
    check_fail "Missing required file: $file"
  fi
done

echo ""

# ============================================
# 5. Directory Structure
# ============================================
echo "📁 Checking Directory Structure..."

REQUIRED_DIRS=(
  "artifacts"
  "claudedocs"
  "scripts"
  "alerts"
)

for dir in "${REQUIRED_DIRS[@]}"; do
  if [ -d "$dir" ]; then
    check_pass "Directory exists: $dir/"
  else
    check_fail "Missing directory: $dir/"
  fi
done

# Check for archive directory
if [ -d "artifacts/archive" ]; then
  check_pass "Archive directory exists: artifacts/archive/"
else
  check_warn "Archive directory not found (will be created during Phase 4)"
fi

echo ""

# ============================================
# 6. CSV Data Integrity
# ============================================
echo "📊 Checking CSV Data Integrity..."

if [ -f "artifacts/observability-24h.csv" ]; then
  CSV_LINES=$(wc -l < artifacts/observability-24h.csv | tr -d ' ')
  CSV_SIZE=$(ls -lh artifacts/observability-24h.csv | awk '{print $5}')

  check_pass "CSV file exists: $CSV_SIZE ($CSV_LINES lines)"

  # Check for valid samples (excluding header)
  VALID_SAMPLES=$(tail -n +2 artifacts/observability-24h.csv | wc -l | tr -d ' ')

  if [ "$VALID_SAMPLES" -ge 20 ]; then
    check_pass "Valid samples in CSV: $VALID_SAMPLES"
  else
    check_warn "Valid samples in CSV: $VALID_SAMPLES (less than expected)"
  fi

  # Quick sanity check: ensure no empty lines
  EMPTY_LINES=$(grep -c "^$" artifacts/observability-24h.csv || echo 0)
  if [ "$EMPTY_LINES" -eq 0 ]; then
    check_pass "CSV contains no empty lines"
  else
    check_warn "CSV contains $EMPTY_LINES empty lines"
  fi
else
  check_fail "CSV file not found: artifacts/observability-24h.csv"
fi

echo ""

# ============================================
# 7. Environment Variables Check
# ============================================
echo "🌍 Checking Environment Variables..."

# Check timezone
CURRENT_TZ=$(date +%Z)
check_pass "Timezone: $CURRENT_TZ (forced to UTC for consistency)"

# Check locale
CURRENT_LOCALE=$(locale | grep LC_ALL | cut -d= -f2)
if [ "$CURRENT_LOCALE" = "C" ]; then
  check_pass "Locale: LC_ALL=C (consistent sorting)"
else
  check_warn "Locale: LC_ALL=$CURRENT_LOCALE (recommend: export LC_ALL=C)"
fi

echo ""

# ============================================
# 8. Network Connectivity
# ============================================
echo "🌐 Checking Network Connectivity..."

# Test GitHub API
if curl -s --max-time 5 https://api.github.com > /dev/null; then
  check_pass "GitHub API reachable"
else
  check_warn "GitHub API unreachable or slow"
fi

# Test gh CLI API access
if gh api /user --jq '.login' &> /dev/null; then
  GH_USER=$(gh api /user --jq '.login')
  check_pass "GitHub CLI authenticated as: $GH_USER"
else
  check_warn "GitHub CLI API access test failed"
fi

echo ""

# ============================================
# 9. Disk Space Check
# ============================================
echo "💾 Checking Disk Space..."

DISK_USAGE=$(df -h . | tail -1 | awk '{print $5}' | tr -d '%')

if [ "$DISK_USAGE" -lt 80 ]; then
  check_pass "Disk usage: ${DISK_USAGE}% (sufficient)"
elif [ "$DISK_USAGE" -lt 90 ]; then
  check_warn "Disk usage: ${DISK_USAGE}% (getting full)"
else
  check_fail "Disk usage: ${DISK_USAGE}% (critically full)"
fi

echo ""

# ============================================
# Summary
# ============================================
echo "=========================================="
echo "Preflight Summary"
echo "=========================================="
echo -e "Total Checks:  $TOTAL_CHECKS"
echo -e "${GREEN}Passed:        $PASSED_CHECKS${NC}"
echo -e "${RED}Failed:        $FAILED_CHECKS${NC}"
echo -e "${YELLOW}Warnings:      $WARNINGS${NC}"
echo ""

if [ $FAILED_CHECKS -eq 0 ]; then
  echo -e "${GREEN}✅ Preflight PASSED - Ready for Phase 4 execution${NC}"
  if [ $WARNINGS -gt 0 ]; then
    echo -e "${YELLOW}⚠️  $WARNINGS warnings present (non-critical)${NC}"
  fi
  echo ""
  echo "🎯 Next Steps:"
  echo "  - Wait for T+12h checkpoint (tomorrow 03:35 CST)"
  echo "  - Wait for T+24h completion (tomorrow 15:35 CST)"
  echo "  - Execute: bash scripts/phase4-fill-final-metrics.sh"
  echo "  - Execute: bash scripts/phase4-verify-artifacts.sh"
  echo "  - Create PR: gh pr create --title '...' --body-file ..."
  exit 0
else
  echo -e "${RED}❌ Preflight FAILED - $FAILED_CHECKS critical checks failed${NC}"
  echo ""
  echo "Please address the failures above before proceeding with Phase 4."
  exit 1
fi
