#!/bin/bash
# archive-phase3-data.sh - Archive Phase 3 observation data for future reference
# Usage: bash scripts/archive-phase3-data.sh

set -euo pipefail

# Configuration
ARCHIVE_DATE=$(date +%Y%m%d_%H%M%S)
ARCHIVE_DIR="artifacts/archive/${ARCHIVE_DATE}"
ARTIFACTS_DIR="artifacts"
ALERTS_DIR="alerts"

echo "🗄️  Phase 3 Data Archival"
echo "=========================="
echo ""
echo "📅 Archive Date: $ARCHIVE_DATE"
echo "📁 Archive Directory: $ARCHIVE_DIR"
echo ""

# Create archive directory
echo "📂 Creating archive directory..."
mkdir -p "$ARCHIVE_DIR"

# Function to archive file if exists
archive_file() {
  local src="$1"
  local desc="$2"

  if [ -f "$src" ]; then
    echo "  ✅ Archiving $desc..."
    cp "$src" "$ARCHIVE_DIR/"
    echo "     → $(basename "$src")"
  else
    echo "  ⚠️  Skipped $desc (not found)"
  fi
}

# Archive Phase 3 observation data
echo ""
echo "📊 Archiving observation data..."
archive_file "$ARTIFACTS_DIR/observability-24h.csv" "24h CSV time-series data"
archive_file "$ARTIFACTS_DIR/observability-24h-summary.json" "24h JSON summary"
archive_file "$ARTIFACTS_DIR/observe-24h.log" "Observation execution log"

# Archive critical alerts if any
echo ""
echo "🚨 Archiving alerts..."
archive_file "$ALERTS_DIR/observability-critical.txt" "Critical alerts log"

# Archive PID file if exists
archive_file "$ARTIFACTS_DIR/observation.pid" "Observation PID file"

# Archive Phase 3 report if exists
echo ""
echo "📄 Archiving Phase 3 reports..."
for report in claudedocs/PHASE3_24H_OBSERVATION_REPORT_*.md; do
  if [ -f "$report" ]; then
    echo "  ✅ Archiving $(basename "$report")..."
    cp "$report" "$ARCHIVE_DIR/"
  fi
done

# Create archive manifest
echo ""
echo "📋 Creating archive manifest..."
cat > "$ARCHIVE_DIR/MANIFEST.txt" << EOF
Phase 3 Observability Data Archive
===================================

Archive Date: $ARCHIVE_DATE
Generated: $(date +"%Y-%m-%d %H:%M:%S %Z")

Archived Files:
---------------
$(ls -lh "$ARCHIVE_DIR" | tail -n +2)

Archive Size:
-------------
$(du -sh "$ARCHIVE_DIR" | cut -f1)

Source Information:
-------------------
- Observation Start: $(jq -r '.observation_start // "N/A"' "$ARTIFACTS_DIR/observability-24h-summary.json" 2>/dev/null || echo "N/A")
- Samples Collected: $(jq -r '.samples_collected // "N/A"' "$ARTIFACTS_DIR/observability-24h-summary.json" 2>/dev/null || echo "N/A")
- Final Status: $(jq -r '.last_status // "N/A"' "$ARTIFACTS_DIR/observability-24h-summary.json" 2>/dev/null || echo "N/A")
- Total Alerts: $(jq -r '.alerts | length // "N/A"' "$ARTIFACTS_DIR/observability-24h-summary.json" 2>/dev/null || echo "N/A")

Restoration Instructions:
-------------------------
To restore this archive:

1. Navigate to archive directory:
   cd artifacts/archive/$ARCHIVE_DATE

2. View manifest:
   cat MANIFEST.txt

3. Copy files back to artifacts/:
   cp observability-24h.csv ../../
   cp observability-24h-summary.json ../../

4. Regenerate report:
   bash scripts/generate-phase3-report.sh

Notes:
------
- Original files remain in artifacts/ directory
- This archive provides historical baseline for future comparisons
- Archived data can be used for trend analysis and regression testing
EOF

echo ""
echo "✅ Archive manifest created"
echo ""

# Display archive summary
echo "📦 Archive Summary"
echo "=================="
echo ""
echo "📁 Location: $ARCHIVE_DIR"
echo "📊 Files Archived: $(ls -1 "$ARCHIVE_DIR" | wc -l | tr -d ' ')"
echo "💾 Total Size: $(du -sh "$ARCHIVE_DIR" | cut -f1)"
echo ""

# Display archived files
echo "📄 Archived Files:"
ls -lh "$ARCHIVE_DIR" | tail -n +2 | awk '{printf "   - %s (%s)\n", $9, $5}'
echo ""

# Verification
echo "🔍 Verification"
echo "==============="
echo ""

# Check if CSV was archived
if [ -f "$ARCHIVE_DIR/observability-24h.csv" ]; then
  local csv_lines=$(wc -l < "$ARCHIVE_DIR/observability-24h.csv" | tr -d ' ')
  echo "✅ CSV archived successfully ($csv_lines lines)"
else
  echo "❌ CSV archive failed"
fi

# Check if summary was archived
if [ -f "$ARCHIVE_DIR/observability-24h-summary.json" ]; then
  echo "✅ Summary JSON archived successfully"
else
  echo "❌ Summary JSON archive failed"
fi

# Check if manifest was created
if [ -f "$ARCHIVE_DIR/MANIFEST.txt" ]; then
  echo "✅ Manifest created successfully"
else
  echo "❌ Manifest creation failed"
fi

echo ""
echo "✨ Phase 3 data archival complete!"
echo ""
echo "📋 Next Steps:"
echo "   1. Review archive manifest: cat $ARCHIVE_DIR/MANIFEST.txt"
echo "   2. Keep original files in artifacts/ for active use"
echo "   3. Use archived data for future baseline comparisons"
echo ""
echo "🗑️  To clean up original files after verification:"
echo "   rm artifacts/observability-24h.{csv,log}"
echo "   rm artifacts/observability-24h-summary.json"
echo "   rm artifacts/observation.pid"
echo ""
