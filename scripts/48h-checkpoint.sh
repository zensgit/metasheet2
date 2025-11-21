#!/bin/bash
# Sprint 2 — 48h Decision Point Checkpoint Script
# Purpose: Check Issue #5 status and guide next actions
# Usage: bash scripts/48h-checkpoint.sh

set -e

REPO="zensgit/metasheet2"
ISSUE_NUM="5"
DECISION_TIME="2025-11-22 22:28:00 CST"

echo "========================================"
echo "Sprint 2 — 48h Decision Point Checkpoint"
echo "========================================"
echo ""
echo "Decision Time: $DECISION_TIME"
echo "Current Time:  $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo ""

# Calculate hours until decision point
DECISION_EPOCH=$(date -j -f "%Y-%m-%d %H:%M:%S %Z" "$DECISION_TIME" "+%s" 2>/dev/null || echo "0")
CURRENT_EPOCH=$(date "+%s")
HOURS_REMAINING=$(( ($DECISION_EPOCH - $CURRENT_EPOCH) / 3600 ))

if [ $HOURS_REMAINING -gt 0 ]; then
    echo "⏰ Time remaining: ~$HOURS_REMAINING hours"
elif [ $HOURS_REMAINING -eq 0 ]; then
    echo "🎯 Decision time has ARRIVED (within 1 hour)"
else
    HOURS_PAST=$(( -$HOURS_REMAINING ))
    echo "⚠️  Decision time PASSED by $HOURS_PAST hours"
fi

echo ""
echo "----------------------------------------"
echo "Checking Issue #$ISSUE_NUM Status..."
echo "----------------------------------------"

# Check if gh CLI is available
if ! command -v gh &> /dev/null; then
    echo "❌ GitHub CLI (gh) not installed"
    echo "   Manual check: https://github.com/$REPO/issues/$ISSUE_NUM"
    echo ""
    echo "Install gh: brew install gh"
    exit 1
fi

# Fetch issue details
ISSUE_DATA=$(gh issue view $ISSUE_NUM --repo $REPO --json title,state,comments,labels 2>&1)

if [ $? -ne 0 ]; then
    echo "❌ Failed to fetch issue data"
    echo "   Error: $ISSUE_DATA"
    echo "   Manual check: https://github.com/$REPO/issues/$ISSUE_NUM"
    exit 1
fi

# Parse issue data
ISSUE_STATE=$(echo "$ISSUE_DATA" | jq -r '.state')
COMMENT_COUNT=$(echo "$ISSUE_DATA" | jq '.comments | length')
LATEST_COMMENT=$(echo "$ISSUE_DATA" | jq -r '.comments[-1].body' 2>/dev/null || echo "")

echo "Issue State: $ISSUE_STATE"
echo "Total Comments: $COMMENT_COUNT"
echo ""

# Check for credentials in latest comments (last 5)
echo "Checking for credentials in recent comments..."
RECENT_COMMENTS=$(echo "$ISSUE_DATA" | jq -r '.comments[-5:][].body')

HAS_BASE_URL=false
HAS_JWT=false

if echo "$RECENT_COMMENTS" | grep -iq "BASE_URL\|staging.*url\|https://.*metasheet"; then
    HAS_BASE_URL=true
fi

if echo "$RECENT_COMMENTS" | grep -iq "JWT\|token.*eyJ\|Bearer.*eyJ"; then
    HAS_JWT=true
fi

echo ""
echo "========================================"
echo "Credential Status"
echo "========================================"
echo "Staging BASE_URL: $([ "$HAS_BASE_URL" = true ] && echo '✅ Found' || echo '❌ Not found')"
echo "Admin JWT Token:  $([ "$HAS_JWT" = true ] && echo '✅ Found' || echo '❌ Not found')"
echo ""

# Decision logic
if [ "$HAS_BASE_URL" = true ] && [ "$HAS_JWT" = true ]; then
    echo "========================================"
    echo "✅ CREDENTIALS AVAILABLE!"
    echo "========================================"
    echo ""
    echo "Next Actions:"
    echo "1. Extract credentials from Issue #$ISSUE_NUM comments"
    echo "2. Export to environment:"
    echo "   export STAGING_URL='<BASE_URL>'"
    echo "   export STAGING_JWT='<JWT_TOKEN>'"
    echo "3. Execute staging validation (60-90 min):"
    echo "   bash scripts/verify-sprint2-staging.sh \"\$STAGING_JWT\" \"\$STAGING_URL\""
    echo "4. Follow checklist: docs/sprint2/post-merge-validation-checklist.md"
    echo ""
    echo "Issue URL: https://github.com/$REPO/issues/$ISSUE_NUM"

elif [ $HOURS_REMAINING -le 0 ]; then
    echo "========================================"
    echo "⏰ 48h DECISION POINT REACHED"
    echo "========================================"
    echo ""
    echo "Credentials Status: ❌ Still unavailable"
    echo ""
    echo "Recommended Action: Submit PR with 'Local Validation Only' label"
    echo ""
    echo "Next Steps:"
    echo "1. Review final validation status:"
    echo "   - docs/sprint2/staging-validation-report.md"
    echo "   - docs/sprint2/pr-description-draft.md"
    echo "2. Ensure all commits pushed:"
    echo "   git push origin feature/sprint2-snapshot-protection"
    echo "3. Create PR with labels:"
    echo "   - 'Local Validation Only'"
    echo "   - 'Staging Verification Required'"
    echo "   - 'P1-high'"
    echo "4. Create post-merge validation issue (linked to PR)"
    echo "5. Document follow-up plan in PR description"
    echo ""
    echo "PR Creation Command:"
    echo "gh pr create --title 'Sprint 2: Snapshot Protection System' \\"
    echo "  --body-file docs/sprint2/pr-description-draft.md \\"
    echo "  --label 'Local Validation Only' \\"
    echo "  --label 'Staging Verification Required' \\"
    echo "  --label 'P1-high'"

elif [ $HOURS_REMAINING -le 2 ]; then
    echo "========================================"
    echo "⚠️  APPROACHING 48h DECISION POINT"
    echo "========================================"
    echo ""
    echo "Time remaining: ~$HOURS_REMAINING hours"
    echo "Credentials: ❌ Still unavailable"
    echo ""
    echo "Recommended Actions:"
    echo "1. Final check of Issue #$ISSUE_NUM in 1-2 hours"
    echo "2. Prepare for PR submission if credentials don't arrive"
    echo "3. Review PR description: docs/sprint2/pr-description-draft.md"
    echo "4. Ensure all documentation is complete"
    echo ""
    echo "Issue URL: https://github.com/$REPO/issues/$ISSUE_NUM"

else
    echo "========================================"
    echo "⏳ WAITING FOR CREDENTIALS"
    echo "========================================"
    echo ""
    echo "Time remaining: ~$HOURS_REMAINING hours"
    echo "Credentials: ❌ Not yet available"
    echo ""
    echo "Recommended Actions:"
    echo "1. Continue monitoring Issue #$ISSUE_NUM"
    echo "2. Check again in 2-4 hours"
    echo "3. Next checkpoint: $(date -v+4H '+%Y-%m-%d %H:%M %Z')"
    echo ""
    echo "Automated Re-check:"
    echo "Run this script again: bash scripts/48h-checkpoint.sh"
    echo ""
    echo "Issue URL: https://github.com/$REPO/issues/$ISSUE_NUM"
fi

echo ""
echo "========================================"
echo "Current Branch Status"
echo "========================================"
git status --short | head -10
git log --oneline -3

echo ""
echo "========================================"
echo "Summary"
echo "========================================"
echo "Latest commit: $(git log -1 --pretty=format:'%h - %s')"
echo "Branch: $(git branch --show-current)"
echo "Issue: https://github.com/$REPO/issues/$ISSUE_NUM"
echo "Docs: docs/sprint2/staging-validation-report.md"
echo ""
