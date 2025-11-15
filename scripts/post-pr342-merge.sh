#!/bin/bash
# Post PR #342 Merge Actions
# Run this script AFTER PR #342 is manually merged
# Purpose: Update all blocked PRs to unblock them

set -e

echo "========================================="
echo "Post PR #342 Merge - PR Update Script"
echo "========================================="
echo ""

# Verify PR #342 is merged
echo "🔍 Verifying PR #342 is merged..."
PR_STATE=$(gh pr view 342 --json state,mergedAt --jq '.state')

if [ "$PR_STATE" != "MERGED" ]; then
  echo "❌ ERROR: PR #342 is not merged yet (state: $PR_STATE)"
  echo "Please merge PR #342 first: https://github.com/zensgit/smartsheet/pull/342"
  exit 1
fi

echo "✅ PR #342 is merged"
MERGED_AT=$(gh pr view 342 --json mergedAt --jq '.mergedAt')
echo "   Merged at: $MERGED_AT"
echo ""

# Critical PRs to update
CRITICAL_PRS=(338 337 83)
DEPENDENCY_PRS=(334 307 299 298 297 296)

echo "========================================="
echo "Step 1: Update Critical PR Branches"
echo "========================================="
echo ""

for pr in "${CRITICAL_PRS[@]}"; do
  echo "📦 Updating PR #$pr branch..."

  # Check if PR is open
  pr_state=$(gh pr view $pr --json state --jq '.state' 2>/dev/null || echo "NOT_FOUND")

  if [ "$pr_state" = "OPEN" ]; then
    gh api repos/zensgit/smartsheet/pulls/$pr/update-branch -X PUT 2>&1 | head -5
    echo "   ✅ Updated PR #$pr"
  elif [ "$pr_state" = "MERGED" ]; then
    echo "   ℹ️  PR #$pr already merged, skipping"
  elif [ "$pr_state" = "CLOSED" ]; then
    echo "   ℹ️  PR #$pr closed, skipping"
  else
    echo "   ⚠️  PR #$pr not found, skipping"
  fi

  sleep 2
done

echo ""
echo "========================================="
echo "Step 2: Update Dependency PR Branches"
echo "========================================="
echo ""

for pr in "${DEPENDENCY_PRS[@]}"; do
  echo "📦 Updating dependency PR #$pr..."

  pr_state=$(gh pr view $pr --json state --jq '.state' 2>/dev/null || echo "NOT_FOUND")

  if [ "$pr_state" = "OPEN" ]; then
    gh api repos/zensgit/smartsheet/pulls/$pr/update-branch -X PUT 2>&1 | head -5
    echo "   ✅ Updated PR #$pr"
  elif [ "$pr_state" = "MERGED" ]; then
    echo "   ℹ️  PR #$pr already merged, skipping"
  elif [ "$pr_state" = "CLOSED" ]; then
    echo "   ℹ️  PR #$pr closed, skipping"
  else
    echo "   ⚠️  PR #$pr not found, skipping"
  fi

  sleep 2
done

echo ""
echo "========================================="
echo "Step 3: Wait for CI to Trigger"
echo "========================================="
echo ""
echo "⏳ Waiting 3 minutes for CI workflows to start..."
echo "   (You can Ctrl+C if you want to check manually later)"

sleep 180

echo ""
echo "========================================="
echo "Step 4: Check Migration Replay Status"
echo "========================================="
echo ""

check_migration_status() {
  local pr=$1
  local pr_state=$(gh pr view $pr --json state --jq '.state' 2>/dev/null || echo "NOT_FOUND")

  if [ "$pr_state" = "OPEN" ]; then
    echo "📊 PR #$pr - Migration Replay Status:"
    gh pr checks $pr 2>/dev/null | grep "Migration Replay" || echo "   ⏳ CI not started yet"
  else
    echo "📊 PR #$pr - Skipped (state: $pr_state)"
  fi
}

echo "Critical PRs:"
for pr in "${CRITICAL_PRS[@]}"; do
  check_migration_status $pr
done

echo ""
echo "Dependency PRs:"
for pr in "${DEPENDENCY_PRS[@]}"; do
  check_migration_status $pr
done

echo ""
echo "========================================="
echo "Summary"
echo "========================================="
echo ""
echo "✅ All open PRs have been updated with the fix from PR #342"
echo ""
echo "📋 Next Steps:"
echo "   1. Monitor CI progress on critical PRs (#338, #337, #83)"
echo "   2. Once Migration Replay passes, these PRs should be unblocked"
echo "   3. Review and merge ready PRs"
echo "   4. Check dependency PRs can be auto-merged if all checks pass"
echo ""
echo "🔗 Quick Links:"
echo "   PR #338: https://github.com/zensgit/smartsheet/pull/338"
echo "   PR #337: https://github.com/zensgit/smartsheet/pull/337"
echo "   PR #83:  https://github.com/zensgit/smartsheet/pull/83"
echo ""
echo "📄 For detailed status, see:"
echo "   metasheet-v2/claudedocs/PR342_FINAL_STATUS.md"
echo ""
