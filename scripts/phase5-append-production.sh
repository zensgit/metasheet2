#!/bin/bash
# Append production baseline auto-filled report section to PHASE5_COMPLETION_REPORT.md
# Usage:
#   ./scripts/phase5-append-production.sh results/phase5-20251124-XXXXXX
# Or let it auto-detect latest results directory:
#   ./scripts/phase5-append-production.sh

set -euo pipefail

RESULTS_DIR=${1:-}
if [ -z "${RESULTS_DIR}" ]; then
  RESULTS_DIR=$(ls -1dt results/phase5-* 2>/dev/null | head -1 || true)
fi

if [ -z "${RESULTS_DIR}" ] || [ ! -d "${RESULTS_DIR}" ]; then
  echo "No results directory found (results/phase5-*)" >&2
  exit 1
fi

CSV="${RESULTS_DIR}/metrics.csv"
if [ ! -f "$CSV" ]; then
  echo "Metrics CSV not found: $CSV" >&2
  exit 1
fi

REPORT_MD="${RESULTS_DIR}/production-report.md"
if [ ! -f "$REPORT_MD" ]; then
  ./scripts/phase5-fill-production-report.sh "$CSV" > "$REPORT_MD"
fi

COMPLETION_DOC="claudedocs/PHASE5_COMPLETION_REPORT.md"
if [ ! -f "$COMPLETION_DOC" ]; then
  echo "Completion report not found: $COMPLETION_DOC" >&2
  exit 1
fi

STAMP=$(date -Iseconds)

echo "Appending production section from $REPORT_MD to $COMPLETION_DOC" >&2

{
  echo ""
  echo "## Production Baseline (Real Data) – Appended ${STAMP}"
  echo "Source Directory: ${RESULTS_DIR}"
  echo ""
  cat "$REPORT_MD"
  echo ""
  echo "### Post-Append Verification Checklist"
  echo "- [ ] Validate success & latency against proposed SLOs"
  echo "- [ ] Confirm cache miss exclusion applied (fallback_ratio vs fb_cache_ratio)"
  echo "- [ ] Decide final global fallback SLO (<5%?)"
  echo "- [ ] Adjust source fallback SLOs if needed"
  echo "- [ ] Tag release v2.5.0-baseline (optional)"
  echo "- [ ] Archive with phase5-archive.sh (if not already)"
  echo ""
} >> "$COMPLETION_DOC"

echo "✅ Append complete." >&2
echo "$COMPLETION_DOC"
