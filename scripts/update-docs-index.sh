#!/bin/bash
##############################################################################
# Documentation Index Update Script
#
# Purpose: Automatically update ANALYSIS_INDEX.md with new observability docs
# Usage: ./scripts/update-docs-index.sh [--dry-run]
##############################################################################

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
INDEX_FILE="$ROOT_DIR/ANALYSIS_INDEX.md"
CLAUDEDOCS_DIR="$ROOT_DIR/claudedocs"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;36m'
NC='\033[0m'

log_info() {
  echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

log_debug() {
  echo -e "${BLUE}[DEBUG]${NC} $1"
}

DRY_RUN=false
if [ "$1" = "--dry-run" ]; then
  DRY_RUN=true
  log_info "Running in DRY-RUN mode (no changes will be made)"
fi

##############################################################################
# Check if index file exists
##############################################################################

if [ ! -f "$INDEX_FILE" ]; then
  log_warn "Index file not found: $INDEX_FILE"
  log_info "Creating new index file..."

  cat > "$INDEX_FILE" << 'EOF'
# MetaSheet Codebase Analysis Index

This is the master index for all analysis and documentation files.

## Core Documentation

- **COMPREHENSIVE_CODEBASE_ANALYSIS.md** - Detailed technical analysis
- **ARCHITECTURE_SUMMARY.md** - Quick reference guide

## Observability & Monitoring

[Observability section will be auto-generated]

## Last Updated

Generated: $(date -Iseconds)
EOF

  log_info "Created new index file"
fi

##############################################################################
# Backup existing index
##############################################################################

if [ "$DRY_RUN" = false ]; then
  BACKUP_FILE="$INDEX_FILE.backup.$(date +%Y%m%d_%H%M%S)"
  cp "$INDEX_FILE" "$BACKUP_FILE"
  log_info "Backup created: $BACKUP_FILE"
fi

##############################################################################
# Generate observability section
##############################################################################

log_info "Scanning for observability documents..."

OBS_DOCS=$(find "$CLAUDEDOCS_DIR" -maxdepth 1 -name "*OBSERVABILITY*" -o -name "*P99*" -o -name "*ROLLBACK*" | sort)

if [ -z "$OBS_DOCS" ]; then
  log_warn "No observability documents found in $CLAUDEDOCS_DIR"
  OBS_SECTION="*No observability documents found yet*"
else
  log_info "Found $(echo "$OBS_DOCS" | wc -l) observability document(s)"

  OBS_SECTION="## Observability & Monitoring

**Purpose**: Post-merge validation, metrics collection, and rollback procedures for observability enhancements.

### Key Documents

"

  # Parse each document and add to index
  while IFS= read -r doc_path; do
    if [ ! -f "$doc_path" ]; then continue; fi

    doc_name=$(basename "$doc_path")
    rel_path="claudedocs/$doc_name"

    # Extract first non-empty line as title (skip markdown header)
    title=$(grep -m 1 '^# ' "$doc_path" | sed 's/^# //' || echo "$doc_name")

    # Extract description from first paragraph
    description=$(sed -n '/^[^#]/p' "$doc_path" | head -1 | cut -c1-100)
    if [ ${#description} -gt 97 ]; then
      description="${description:0:97}..."
    fi

    log_debug "  Processing: $doc_name"

    OBS_SECTION+="**[$doc_name]($rel_path)**
- **Title**: $title
- **Description**: ${description:-No description available}

"
  done <<< "$OBS_DOCS"

  # Add related files section
  OBS_SECTION+="
### Related Files

**Scripts**:
- \`scripts/rollback-observability.sh\` - Emergency rollback automation
- \`scripts/verify-db-schema.js\` - Database consistency verification
- \`scripts/collect-p99-baseline.sh\` - P99 latency baseline collection
- \`scripts/update-docs-index.sh\` - This script

**Workflows**:
- \`.github/workflows/observability-metrics-lite.yml\` - Metrics collection
- \`.github/workflows/observability-strict.yml\` - Strict validation gate

**Key Metrics**:
- Approval success rate: Target >95%
- RBAC P99 latency: Target <50ms
- Cache hit rate: Target >80% (when Redis enabled)
- Fallback usage: Target <10%
"
fi

##############################################################################
# Update index file
##############################################################################

# Remove existing observability section if present
TEMP_FILE="$INDEX_FILE.tmp"

# Find the observability section and remove it
awk '
  /^## Observability & Monitoring/ { skip=1; next }
  /^## [^O]/ { skip=0 }
  !skip { print }
' "$INDEX_FILE" > "$TEMP_FILE"

# Find the insertion point (after "## Core Documentation" section)
awk -v obs_section="$OBS_SECTION" '
  /^## Core Documentation/ {
    in_core=1
    print
    next
  }
  in_core && /^## / {
    # End of Core Documentation section
    print ""
    print obs_section
    print ""
    in_core=0
  }
  { print }
' "$TEMP_FILE" > "$TEMP_FILE.2"

# Update timestamp
sed -i.bak "s/Generated:.*/Generated: $(date -Iseconds)/" "$TEMP_FILE.2"

if [ "$DRY_RUN" = true ]; then
  log_info "DRY-RUN: Would update $INDEX_FILE with:"
  echo ""
  echo "----------------------------------------"
  echo "$OBS_SECTION"
  echo "----------------------------------------"
  echo ""

  # Cleanup
  rm -f "$TEMP_FILE" "$TEMP_FILE.2" "$TEMP_FILE.2.bak"
else
  mv "$TEMP_FILE.2" "$INDEX_FILE"
  rm -f "$TEMP_FILE" "$TEMP_FILE.2.bak"

  log_info "✅ Index file updated: $INDEX_FILE"
  log_info "Changes:"
  log_info "  - Added/updated Observability & Monitoring section"
  log_info "  - Updated generation timestamp"
fi

##############################################################################
# Verify update
##############################################################################

if [ "$DRY_RUN" = false ]; then
  if grep -q "Observability & Monitoring" "$INDEX_FILE"; then
    log_info "✅ Verification: Observability section found in index"
  else
    log_warn "⚠️  Verification: Observability section NOT found. Manual check required."
  fi

  # Show stats
  TOTAL_LINES=$(wc -l < "$INDEX_FILE")
  log_info "Index file stats: $TOTAL_LINES lines"
fi

log_info "Done!"
