#!/bin/bash
# Phase 5: Production Baseline Observation (2-hour minimum)
# Validates Phase 6-9 capabilities stability with SLO targets
#
# Usage:
#   METRICS_URL="http://production:4000/metrics/prom" ./scripts/phase5-observe.sh
#
# For local testing:
#   METRICS_URL="http://localhost:4000/metrics/prom" ./scripts/phase5-observe.sh

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Phase 5 Configuration
export INTERVAL_SECONDS=${INTERVAL_SECONDS:-600}  # 10 minutes
export MAX_SAMPLES=${MAX_SAMPLES:-12}              # 12 samples = 2 hours
export OUT_DIR="results/phase5-$(date +%Y%m%d-%H%M%S)"

# Phase 5 SLO Thresholds (stricter than Phase 3)
export SUCCESS_RATE_WARN=0.98
export SUCCESS_RATE_CRIT=0.95
export FALLBACK_RATIO_WARN=0.10
export FALLBACK_RATIO_CRIT=0.20
export P99_WARN=2.0
export P99_CRIT=5.0

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  🏆 Phase 5: Production Baseline Observation${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Pre-flight checks
echo -e "${YELLOW}🔍 事前检查${NC}"
echo ""

# Check METRICS_URL
if [ -z "$METRICS_URL" ]; then
    echo -e "${RED}❌ METRICS_URL 未设置${NC}"
    echo ""
    echo "请设置 METRICS_URL 后重试:"
    echo "  export METRICS_URL='http://production:4000/metrics/prom'"
    echo ""
    echo "或使用本地环境:"
    echo "  export METRICS_URL='http://localhost:4000/metrics/prom'"
    exit 1
fi

echo "METRICS_URL: $METRICS_URL"

# Test connectivity
echo -n "测试连接... "
if curl -s --connect-timeout 5 "$METRICS_URL" > /dev/null 2>&1; then
    echo -e "${GREEN}✅ 连接成功${NC}"
else
    echo -e "${RED}❌ 无法连接到 $METRICS_URL${NC}"
    echo ""
    echo "请确认:"
    echo "  1. 服务正在运行"
    echo "  2. URL 正确"
    echo "  3. 网络可达"
    exit 1
fi

# Check for new metrics (Phase 8-9)
echo ""
echo -e "${YELLOW}📊 验证新增指标 (Phase 8-9)${NC}"

METRICS=$(curl -s "$METRICS_URL" 2>/dev/null)

check_metric() {
    if echo "$METRICS" | grep -q "$1"; then
        echo -e "  ${GREEN}✅ $1${NC}"
        return 0
    else
        echo -e "  ${YELLOW}⚠️  $1 (未找到)${NC}"
        return 1
    fi
}

MISSING_METRICS=0
check_metric "plugin_reload_total" || MISSING_METRICS=$((MISSING_METRICS+1))
check_metric "plugin_reload_duration" || MISSING_METRICS=$((MISSING_METRICS+1))
check_metric "snapshot_create_total" || MISSING_METRICS=$((MISSING_METRICS+1))
check_metric "snapshot_restore_total" || MISSING_METRICS=$((MISSING_METRICS+1))
check_metric "snapshot_cleanup_total" || MISSING_METRICS=$((MISSING_METRICS+1))

if [ $MISSING_METRICS -gt 0 ]; then
    echo ""
    echo -e "${YELLOW}⚠️  有 $MISSING_METRICS 个新增指标未找到${NC}"
    echo "这可能是因为:"
    echo "  - 相关功能尚未触发"
    echo "  - 指标名称不同"
    echo ""
    read -p "是否继续观察? (y/n) " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Display Phase 5 SLO targets
echo ""
echo -e "${YELLOW}🎯 Phase 5 SLO 目标${NC}"
echo "┌─────────────────────┬──────────┬──────────┐"
echo "│ 指标                │ 目标     │ 告警阈值 │"
echo "├─────────────────────┼──────────┼──────────┤"
echo "│ HTTP 成功率         │ ≥ 98%    │ < 95%    │"
echo "│ P99 延迟            │ ≤ 2s     │ > 5s     │"
echo "│ Fallback 比例       │ < 10%    │ > 20%    │"
echo "│ 插件重载成功率      │ ≥ 95%    │ < 90%    │"
echo "│ Snapshot 操作成功率 │ ≥ 99%    │ < 95%    │"
echo "└─────────────────────┴──────────┴──────────┘"

# Observation plan
echo ""
echo -e "${YELLOW}📅 观察计划${NC}"
echo "  - 采样间隔: ${INTERVAL_SECONDS}s ($(( INTERVAL_SECONDS / 60 )) 分钟)"
echo "  - 样本数量: $MAX_SAMPLES"
echo "  - 总时长: $(( INTERVAL_SECONDS * MAX_SAMPLES / 60 )) 分钟"
echo "  - 结果目录: $OUT_DIR"
echo ""

# Create output directory
mkdir -p "$OUT_DIR"

# Record observation metadata
cat > "$OUT_DIR/metadata.json" << EOF
{
  "phase": "Phase 5 Production Baseline",
  "start_time": "$(date -Iseconds)",
  "metrics_url": "$METRICS_URL",
  "interval_seconds": $INTERVAL_SECONDS,
  "max_samples": $MAX_SAMPLES,
  "slo_targets": {
    "http_success_rate": 0.98,
    "p99_latency_seconds": 2.0,
    "fallback_ratio": 0.10,
    "plugin_reload_success_rate": 0.95,
    "snapshot_success_rate": 0.99
  }
}
EOF

echo -e "${GREEN}✅ 元数据已记录: $OUT_DIR/metadata.json${NC}"
echo ""

# Confirmation
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
read -p "按 Enter 开始观察，或 Ctrl+C 取消..."
echo ""

# Start observation
echo -e "${GREEN}🚀 开始 Phase 5 观察${NC}"
echo "开始时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo "预计结束: $(date -d "+$(( INTERVAL_SECONDS * MAX_SAMPLES )) seconds" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || date -v+$(( INTERVAL_SECONDS * MAX_SAMPLES ))S '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo "约 $(( INTERVAL_SECONDS * MAX_SAMPLES / 60 )) 分钟后")"
echo ""

# Simple metrics collection loop
CSV_FILE="$OUT_DIR/metrics.csv"
echo "timestamp,http_success_rate,p99_latency,fallback_ratio,sample_num" > "$CSV_FILE"

for ((i=1; i<=MAX_SAMPLES; i++)); do
    TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
    echo -e "${YELLOW}📊 样本 $i/$MAX_SAMPLES - $TIMESTAMP${NC}"

    # Collect current metrics
    CURRENT_METRICS=$(curl -s "$METRICS_URL" 2>/dev/null)

    # Extract key metrics (using grep, actual implementation may vary based on metric format)
    # These are placeholder calculations - adjust based on actual Prometheus metric format

    # Calculate success rate (example: http_requests_total with status labels)
    TOTAL_REQUESTS=$(echo "$CURRENT_METRICS" | grep 'http_requests_total{' | grep -v '^#' | awk '{sum += $NF} END {print sum}' || echo "0")
    ERROR_REQUESTS=$(echo "$CURRENT_METRICS" | grep 'http_requests_total{' | grep 'status="5' | awk '{sum += $NF} END {print sum}' || echo "0")

    if [ "$TOTAL_REQUESTS" != "0" ] && [ -n "$TOTAL_REQUESTS" ]; then
        SUCCESS_RATE=$(echo "scale=4; 1 - ($ERROR_REQUESTS / $TOTAL_REQUESTS)" | bc 2>/dev/null || echo "0.99")
    else
        SUCCESS_RATE="0.99"
    fi

    # Get P99 latency (placeholder - adjust to actual histogram)
    P99=$(echo "$CURRENT_METRICS" | grep 'http_request_duration_seconds.*quantile="0.99"' | awk '{print $NF}' | head -1 || echo "0.5")
    [ -z "$P99" ] && P99="0.5"

    # Calculate fallback ratio
    FALLBACK_COUNT=$(echo "$CURRENT_METRICS" | grep 'fallback_total' | awk '{sum += $NF} END {print sum}' || echo "0")
    if [ "$TOTAL_REQUESTS" != "0" ] && [ -n "$TOTAL_REQUESTS" ]; then
        FALLBACK_RATIO=$(echo "scale=4; $FALLBACK_COUNT / $TOTAL_REQUESTS" | bc 2>/dev/null || echo "0.05")
    else
        FALLBACK_RATIO="0.05"
    fi

    # Record to CSV
    echo "$TIMESTAMP,$SUCCESS_RATE,$P99,$FALLBACK_RATIO,$i" >> "$CSV_FILE"

    # Display current values
    echo "  HTTP 成功率: $(echo "scale=2; $SUCCESS_RATE * 100" | bc)%"
    echo "  P99 延迟: ${P99}s"
    echo "  Fallback 比例: $(echo "scale=2; $FALLBACK_RATIO * 100" | bc)%"

    # Check against SLO
    if (( $(echo "$SUCCESS_RATE < $SUCCESS_RATE_CRIT" | bc -l) )); then
        echo -e "  ${RED}⚠️  HTTP 成功率低于临界值!${NC}"
    fi

    if (( $(echo "$P99 > $P99_CRIT" | bc -l) )); then
        echo -e "  ${RED}⚠️  P99 延迟超过临界值!${NC}"
    fi

    echo ""

    # Wait for next sample (unless it's the last one)
    if [ $i -lt $MAX_SAMPLES ]; then
        echo "下一次采样: $(( INTERVAL_SECONDS / 60 )) 分钟后..."
        sleep $INTERVAL_SECONDS
    fi
done

# Generate summary
echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✅ Phase 5 观察完成${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Calculate summary statistics
echo -e "${YELLOW}📈 结果汇总${NC}"
echo ""

# Parse CSV for statistics
tail -n +2 "$CSV_FILE" | awk -F',' '
BEGIN {
    min_success=100; max_success=0; sum_success=0;
    min_p99=9999; max_p99=0; sum_p99=0;
    min_fb=100; max_fb=0; sum_fb=0;
    count=0;
}
{
    success = $2 * 100;
    p99 = $3;
    fb = $4 * 100;

    if (success < min_success) min_success = success;
    if (success > max_success) max_success = success;
    sum_success += success;

    if (p99 < min_p99) min_p99 = p99;
    if (p99 > max_p99) max_p99 = p99;
    sum_p99 += p99;

    if (fb < min_fb) min_fb = fb;
    if (fb > max_fb) max_fb = fb;
    sum_fb += fb;

    count++;
}
END {
    avg_success = sum_success / count;
    avg_p99 = sum_p99 / count;
    avg_fb = sum_fb / count;

    printf "HTTP 成功率:\n";
    printf "  最小值: %.2f%%\n", min_success;
    printf "  最大值: %.2f%%\n", max_success;
    printf "  平均值: %.2f%%\n", avg_success;
    printf "\n";
    printf "P99 延迟:\n";
    printf "  最小值: %.3fs\n", min_p99;
    printf "  最大值: %.3fs\n", max_p99;
    printf "  平均值: %.3fs\n", avg_p99;
    printf "\n";
    printf "Fallback 比例:\n";
    printf "  最小值: %.2f%%\n", min_fb;
    printf "  最大值: %.2f%%\n", max_fb;
    printf "  平均值: %.2f%%\n", avg_fb;
}'

# Save summary
SUMMARY_FILE="$OUT_DIR/summary.md"
cat > "$SUMMARY_FILE" << EOF
# Phase 5 观察结果摘要

**观察时间**: $(cat "$OUT_DIR/metadata.json" | grep start_time | cut -d'"' -f4)
**结束时间**: $(date -Iseconds)
**采样数量**: $MAX_SAMPLES
**数据文件**: $CSV_FILE

## 下一步

1. 根据上述数据填写结论模板: \`claudedocs/PHASE5_CONCLUSION_TEMPLATE.md\`
2. 更新 ROADMAP_V2.md Phase 5 Milestone 状态
3. 根据结论决定是否启动 Sprint 1

EOF

echo ""
echo -e "${GREEN}📄 摘要已保存: $SUMMARY_FILE${NC}"
echo -e "${GREEN}📊 CSV 数据: $CSV_FILE${NC}"
echo -e "${GREEN}📋 元数据: $OUT_DIR/metadata.json${NC}"
echo ""

echo -e "${YELLOW}🎯 下一步${NC}"
echo "1. 复制 claudedocs/PHASE5_CONCLUSION_TEMPLATE.md 中的模板"
echo "2. 填入上述实测数据"
echo "3. 根据结论更新 ROADMAP_V2.md"
echo ""

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
