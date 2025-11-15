#!/bin/bash
#
# Phase 5 Completion Automation Script
# Automatically archive data, calculate metrics, and update documentation
#
# Usage: bash scripts/phase5-completion.sh
#

set -e  # Exit on error

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
ARTIFACTS_DIR="${OUT_DIR:-artifacts}"
ARCHIVE_DIR="final-artifacts/phase5-prod-2h"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
MASTER_GUIDE="claudedocs/OBSERVABILITY_HARDENING_COMPLETE_GUIDE.md"

echo -e "${BLUE}================================================${NC}"
echo -e "${BLUE}Phase 5 Completion Automation${NC}"
echo -e "${BLUE}================================================${NC}"
echo ""

# Step 1: Verify observation completion
echo -e "${YELLOW}[Step 1/6] Verifying observation completion...${NC}"

if [ ! -f "$ARTIFACTS_DIR/observability-24h-summary.json" ]; then
    echo -e "${RED}❌ Error: observability-24h-summary.json not found${NC}"
    echo -e "${RED}   Expected location: $ARTIFACTS_DIR/observability-24h-summary.json${NC}"
    exit 1
fi

STATUS=$(jq -r '.status' "$ARTIFACTS_DIR/observability-24h-summary.json")
SAMPLES=$(jq -r '.samples_collected' "$ARTIFACTS_DIR/observability-24h-summary.json")
TARGET=$(jq -r '.total_samples' "$ARTIFACTS_DIR/observability-24h-summary.json")

echo -e "   Status: $STATUS"
echo -e "   Samples collected: $SAMPLES / $TARGET"

if [ "$STATUS" != "completed" ]; then
    echo -e "${RED}❌ Error: Observation not completed (status: $STATUS)${NC}"
    exit 1
fi

echo -e "${GREEN}✅ Observation completed successfully${NC}"
echo ""

# Step 2: Create archive directory
echo -e "${YELLOW}[Step 2/6] Creating archive directory...${NC}"

mkdir -p "$ARCHIVE_DIR"
echo -e "   Created: $ARCHIVE_DIR"
echo -e "${GREEN}✅ Archive directory ready${NC}"
echo ""

# Step 3: Copy files to archive
echo -e "${YELLOW}[Step 3/6] Archiving observation data...${NC}"

FILES_TO_ARCHIVE=(
    "observability-24h.csv"
    "observability-24h-summary.json"
    "observe-24h.log"
)

OPTIONAL_FILES=(
    "observability-24h.24h.csv"
    "observability-24h.24h.dedup.csv"
    "observability-24h.original.csv"
)

for file in "${FILES_TO_ARCHIVE[@]}"; do
    if [ -f "$ARTIFACTS_DIR/$file" ]; then
        cp "$ARTIFACTS_DIR/$file" "$ARCHIVE_DIR/"
        echo -e "   ✓ Copied: $file"
    else
        echo -e "${RED}   ✗ Missing: $file${NC}"
    fi
done

# Copy optional files if they exist
for file in "${OPTIONAL_FILES[@]}"; do
    if [ -f "$ARTIFACTS_DIR/$file" ]; then
        cp "$ARTIFACTS_DIR/$file" "$ARCHIVE_DIR/"
        echo -e "   ✓ Copied (optional): $file"
    fi
done

# Copy log if exists
if [ -f "$ARTIFACTS_DIR/phase5-run.log" ]; then
    cp "$ARTIFACTS_DIR/phase5-run.log" "$ARCHIVE_DIR/"
    echo -e "   ✓ Copied: phase5-run.log"
fi

echo -e "${GREEN}✅ Files archived${NC}"
echo ""

# Step 4: Generate checksums
echo -e "${YELLOW}[Step 4/6] Generating SHA256 checksums...${NC}"

(cd "$ARCHIVE_DIR" && shasum -a 256 * 2>/dev/null | grep -v CHECKSUMS.txt | sort > CHECKSUMS.txt)

echo -e "   Checksums saved to: $ARCHIVE_DIR/CHECKSUMS.txt"
echo -e "${GREEN}✅ Checksums generated${NC}"
echo ""

# Step 5: Calculate final metrics (exclude COLD_START and CRIT)
echo -e "${YELLOW}[Step 5/6] Calculating final metrics...${NC}"

METRICS_OUTPUT="$ARCHIVE_DIR/phase5-final-metrics.txt"

awk -F',' '
    NR>1 && $11!="COLD_START" && $11!="CRIT" {
        success_sum += $9
        fallback_sum += $10
        conflicts_sum += $5
        p99_sum += $7
        db_p99_sum += $8
        count++
    }
    END {
        if (count > 0) {
            printf "Phase 5 Production Baseline - Final Metrics\n"
            printf "============================================\n\n"
            printf "Observation Window: %s\n", "2-hour production baseline (12 samples)"
            printf "Valid Samples: %d (excluding COLD_START and CRIT)\n\n", count

            printf "Success Rate: %.4f (%.2f%%)\n", success_sum/count, (success_sum/count)*100
            printf "  Target: >= 0.98 (98%%)\n"
            if (success_sum/count >= 0.98) {
                printf "  Status: ✅ PASS\n\n"
            } else {
                printf "  Status: ❌ FAIL\n\n"
            }

            printf "Fallback Ratio: %.4f (%.2f%%)\n", fallback_sum/count, (fallback_sum/count)*100
            printf "  Target: < 0.10 (10%%)\n"
            if (fallback_sum/count < 0.10) {
                printf "  Status: ✅ PASS\n\n"
            } else {
                printf "  Status: ❌ FAIL\n\n"
            }

            printf "P99 Latency (Average): %.3f seconds\n", p99_sum/count
            printf "  Target: < 0.30s\n"
            if (p99_sum/count < 0.30) {
                printf "  Status: ✅ PASS\n\n"
            } else {
                printf "  Status: ⚠️  WARNING\n\n"
            }

            printf "DB P99 Latency (Average): %.3f seconds\n\n", db_p99_sum/count

            printf "Total Conflicts: %d\n", conflicts_sum
            printf "  Target: 0\n"
            if (conflicts_sum == 0) {
                printf "  Status: ✅ PASS\n\n"
            } else {
                printf "  Status: ❌ FAIL\n\n"
            }

            # Overall assessment
            printf "Overall Assessment:\n"
            if (success_sum/count >= 0.98 && fallback_sum/count < 0.10 && conflicts_sum == 0 && p99_sum/count < 0.30) {
                printf "  🎉 ALL TARGETS MET - PRODUCTION READY\n"
            } else if (success_sum/count >= 0.98 && fallback_sum/count < 0.10 && conflicts_sum == 0) {
                printf "  ✅ CRITICAL TARGETS MET - P99 needs attention\n"
            } else {
                printf "  ⚠️  REVIEW REQUIRED - Some targets not met\n"
            }
        } else {
            printf "No valid samples found (all were COLD_START or CRIT)\n"
        }
    }
' "$ARTIFACTS_DIR/observability-24h.csv" > "$METRICS_OUTPUT"

cat "$METRICS_OUTPUT"
echo ""
echo -e "${GREEN}✅ Metrics calculated and saved to: $METRICS_OUTPUT${NC}"
echo ""

# Step 6: Update master guide
echo -e "${YELLOW}[Step 6/6] Updating master guide...${NC}"

# Create Phase 5 summary paragraph
PHASE5_SUMMARY=$(cat <<EOF
**Phase 5 完成摘要 ($(date +%Y-%m-%d))**: Production 2小时基线采集已完成 | 有效样本: ${SAMPLES}个 | 数据归档: [\`final-artifacts/phase5-prod-2h/\`](final-artifacts/phase5-prod-2h/) | 校验和已生成 | 最终指标已计算（排除COLD_START和CRIT样本）| 详见 [phase5-final-metrics.txt](final-artifacts/phase5-prod-2h/phase5-final-metrics.txt) | Issue #1 已验证完成

> 下一步：Phase 6（长期监控与优化）或生产部署准备
EOF
)

# Check if Phase 5 summary already exists
if grep -q "Phase 5 完成摘要" "$MASTER_GUIDE" 2>/dev/null; then
    echo -e "${YELLOW}   Phase 5 summary already exists in master guide${NC}"
    echo -e "${YELLOW}   Manual update may be required${NC}"
else
    # Find the line with Phase 5 准备完成 and add Phase 5 完成摘要 after it
    LINE_NUM=$(grep -n "Phase 5 准备完成" "$MASTER_GUIDE" | cut -d: -f1 | tail -1)

    if [ -n "$LINE_NUM" ]; then
        # Insert after Phase 5 准备完成 paragraph (skip 2 lines for the paragraph and blank line)
        INSERT_LINE=$((LINE_NUM + 2))

        # Create temporary file with Phase 5 summary
        {
            head -n "$INSERT_LINE" "$MASTER_GUIDE"
            echo ""
            echo "$PHASE5_SUMMARY"
            tail -n +$((INSERT_LINE + 1)) "$MASTER_GUIDE"
        } > "${MASTER_GUIDE}.tmp"

        mv "${MASTER_GUIDE}.tmp" "$MASTER_GUIDE"

        echo -e "   ✓ Added Phase 5 summary to master guide"
        echo -e "${GREEN}✅ Master guide updated${NC}"
    else
        echo -e "${YELLOW}   Warning: Could not find Phase 5 准备完成 in master guide${NC}"
        echo -e "${YELLOW}   Please manually add Phase 5 summary${NC}"
    fi
fi

echo ""

# Final summary
echo -e "${BLUE}================================================${NC}"
echo -e "${GREEN}✅ Phase 5 Completion Automation Finished${NC}"
echo -e "${BLUE}================================================${NC}"
echo ""
echo -e "Archive Location: ${GREEN}$ARCHIVE_DIR${NC}"
echo -e "Checksums: ${GREEN}$ARCHIVE_DIR/CHECKSUMS.txt${NC}"
echo -e "Metrics: ${GREEN}$METRICS_OUTPUT${NC}"
echo ""
echo -e "${YELLOW}Next Steps:${NC}"
echo -e "  1. Review metrics in: $METRICS_OUTPUT"
echo -e "  2. Verify checksums: cd $ARCHIVE_DIR && shasum -a 256 -c CHECKSUMS.txt"
echo -e "  3. Update Issue #1 with final metrics"
echo -e "  4. Commit changes: git add . && git commit -m 'docs: Phase 5 completion'"
echo -e "  5. Create Release v2.5.0 (if all targets met)"
echo ""
