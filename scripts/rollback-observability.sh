#!/bin/bash
##############################################################################
# Observability Hardening Rollback Script
#
# Purpose: Emergency rollback for observability-hardening merge
# Usage: ./scripts/rollback-observability.sh [--confirm]
# Requirements: gh CLI, psql (if db rollback needed)
##############################################################################

set -e

REPO="${GITHUB_REPOSITORY:-zensgit/smartsheet}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
  echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1"
}

##############################################################################
# Pre-flight checks
##############################################################################

if [ "$1" != "--confirm" ]; then
  log_error "This script will rollback observability-hardening changes."
  echo ""
  echo "This includes:"
  echo "  - Disabling strict metrics gate (OBS_METRICS_STRICT=false)"
  echo "  - Restoring branch protection settings"
  echo "  - Optionally rolling back database migrations"
  echo "  - Cleaning up metrics artifacts"
  echo ""
  echo "To proceed, run: $0 --confirm"
  exit 1
fi

if ! command -v gh &> /dev/null; then
  log_error "GitHub CLI (gh) not found. Install: https://cli.github.com/"
  exit 1
fi

log_info "Starting Observability Hardening Rollback..."
echo ""

##############################################################################
# Step 1: Disable strict metrics gate
##############################################################################

log_info "Step 1: Disabling strict metrics gate..."
gh variable set OBS_METRICS_STRICT --body "false" --repo "$REPO" || {
  log_warn "Failed to set OBS_METRICS_STRICT (may not exist yet)"
}
log_info "✅ Strict metrics gate disabled"
echo ""

##############################################################################
# Step 2: Restore branch protection
##############################################################################

log_info "Step 2: Restoring branch protection settings..."
BACKUP_FILE="$ROOT_DIR/.github/branch-protection-backup.json"

if [ -f "$BACKUP_FILE" ]; then
  log_info "Found backup: $BACKUP_FILE"

  # Restore using gh api
  gh api --method PUT \
    "/repos/$REPO/branches/main/protection" \
    --input "$BACKUP_FILE" || {
      log_error "Failed to restore branch protection. Manual restore required."
      log_warn "Backup file: $BACKUP_FILE"
    }

  log_info "✅ Branch protection restored"
else
  log_warn "No backup file found at: $BACKUP_FILE"
  log_warn "Skipping branch protection restoration"
fi
echo ""

##############################################################################
# Step 3: Optional database migration rollback
##############################################################################

log_info "Step 3: Checking for database migration rollbacks..."
ROLLBACK_SQL="$ROOT_DIR/packages/core-backend/src/db/migrations/rollback-observability.sql"

if [ -f "$ROLLBACK_SQL" ]; then
  read -p "Database rollback script found. Execute? (y/N): " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    if [ -z "$DATABASE_URL" ]; then
      log_error "DATABASE_URL not set. Cannot rollback database."
    else
      log_info "Executing database rollback..."
      psql "$DATABASE_URL" -f "$ROLLBACK_SQL" || {
        log_error "Database rollback failed. Manual intervention required."
      }
      log_info "✅ Database migrations rolled back"
    fi
  else
    log_info "Skipping database rollback"
  fi
else
  log_info "No database rollback script found (this is normal)"
fi
echo ""

##############################################################################
# Step 4: Clean up metrics artifacts
##############################################################################

log_info "Step 4: Cleaning up recent metrics run artifacts..."

# Get recent Metrics Lite runs
WORKFLOW_NAME="Observability Metrics Lite"
RECENT_RUNS=$(gh run list \
  --repo "$REPO" \
  --workflow "$WORKFLOW_NAME" \
  --limit 5 \
  --json databaseId \
  -q '.[].databaseId')

if [ -n "$RECENT_RUNS" ]; then
  log_info "Found $(echo "$RECENT_RUNS" | wc -l) recent runs to clean up"

  for run_id in $RECENT_RUNS; do
    gh run delete "$run_id" --repo "$REPO" 2>/dev/null || true
    log_info "  Deleted run: $run_id"
  done

  log_info "✅ Metrics artifacts cleaned"
else
  log_info "No recent metrics runs to clean"
fi
echo ""

##############################################################################
# Step 5: Trigger CI verification
##############################################################################

log_info "Step 5: Triggering CI verification on main branch..."
gh workflow run "CI Tests" --repo "$REPO" --ref main || {
  log_warn "Failed to trigger CI Tests workflow"
  log_warn "Manually trigger at: https://github.com/$REPO/actions"
}
log_info "✅ CI verification triggered"
echo ""

##############################################################################
# Summary
##############################################################################

log_info "🎉 Rollback Complete!"
echo ""
echo "Next steps:"
echo "  1. Monitor CI run: gh run list --repo $REPO --branch main --limit 3"
echo "  2. Check health: curl http://localhost:8900/health"
echo "  3. Review logs in: $ROOT_DIR/claudedocs/ROLLBACK_LOG_$(date +%Y%m%d_%H%M%S).md"
echo ""
echo "If issues persist, refer to:"
echo "  - $ROOT_DIR/claudedocs/OBSERVABILITY_ROLLBACK_SOP.md"
echo "  - GitHub Issues: https://github.com/$REPO/issues"
echo ""

# Create rollback log
LOG_FILE="$ROOT_DIR/claudedocs/ROLLBACK_LOG_$(date +%Y%m%d_%H%M%S).md"
cat > "$LOG_FILE" << EOF
# Observability Rollback Log

**Date**: $(date -Iseconds)
**Repository**: $REPO
**Branch**: main
**Executed By**: $(whoami)

## Actions Taken

- ✅ Disabled OBS_METRICS_STRICT variable
- ✅ Restored branch protection (if backup existed)
- ⏩ Database rollback (skipped or executed based on prompt)
- ✅ Cleaned up metrics artifacts
- ✅ Triggered CI verification

## Verification Commands

\`\`\`bash
# Check variable
gh variable list --repo $REPO | grep OBS_METRICS_STRICT

# Check CI status
gh run list --repo $REPO --branch main --limit 3

# Check server health
curl http://localhost:8900/health
\`\`\`

## Status

Current system status: **ROLLED BACK**

Review OBSERVABILITY_ROLLBACK_SOP.md for post-rollback checklist.
EOF

log_info "Rollback log saved: $LOG_FILE"
