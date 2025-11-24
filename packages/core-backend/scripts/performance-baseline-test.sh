#!/bin/bash
set -e

API_TOKEN=$1
BASE_URL=${2:-"http://localhost:8900"}

if [ -z "$API_TOKEN" ]; then
  echo "Usage: $0 <API_TOKEN> [BASE_URL]"
  echo "Example: $0 my-token http://staging:8900"
  exit 1
fi

echo "=== Sprint 2 性能基线测试 ==="
echo "目标: 平均 < 100ms, P95 < 150ms, P99 < 250ms"
echo "BASE_URL: $BASE_URL"
echo "开始时间: $(date)"
echo ""

# 清理之前的测试数据
rm -f /tmp/eval-times-*.txt /tmp/sorted-*.txt

# 1. 创建测试规则（N=200）
echo "步骤 1: 创建 200 条测试规则..."
created_rules=()

for i in {1..200}; do
  complexity=$((i % 3))
  case $complexity in
    0) # 简单规则 (33%)
      CONDITIONS='{"all": [{"field": "protection_level", "operator": "eq", "value": "protected"}]}'
      ;;
    1) # 中等复杂度 (33%)
      CONDITIONS='{"any": [{"field": "tags", "operator": "contains", "value": "test"}, {"field": "protection_level", "operator": "ne", "value": "normal"}]}'
      ;;
    2) # 复杂规则 (33%)
      CONDITIONS='{"all": [{"field": "protection_level", "operator": "in", "value": ["protected", "critical"]}, {"any": [{"field": "tags", "operator": "contains", "value": "prod"}, {"field": "release_channel", "operator": "eq", "value": "stable"}]}]}'
      ;;
  esac

  rule_id=$(curl -X POST "$BASE_URL/api/admin/safety/rules" \
    -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
      \"rule_name\": \"perf-test-rule-$i\",
      \"description\": \"Performance test rule - complexity level $complexity\",
      \"target_type\": \"snapshot\",
      \"priority\": $((1000 - i)),
      \"conditions\": $CONDITIONS,
      \"effects\": {\"action\": \"block\", \"message\": \"Performance test\"}
    }" -s | jq -r '.id // empty')

  if [ -n "$rule_id" ]; then
    created_rules+=("$rule_id")
  fi

  if [ $((i % 50)) -eq 0 ]; then
    echo "  创建进度: $i/200"
  fi
done

echo "✅ 成功创建 ${#created_rules[@]} 条规则"
echo ""

# 2. 单线程性能测试（M=500）
echo "步骤 2: 单线程性能测试 (500 次评估)..."
echo "  预计耗时: 25-50 秒"

for i in {1..500}; do
  curl -X POST "$BASE_URL/api/admin/safety/rules/evaluate" \
    -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
      \"entity_type\": \"snapshot\",
      \"entity_id\": \"test-$i\",
      \"operation\": \"delete\",
      \"properties\": {
        \"protection_level\": \"protected\",
        \"tags\": [\"test\", \"prod\"],
        \"release_channel\": \"stable\"
      }
    }" -s -w "%{time_total}\n" -o /dev/null >> /tmp/eval-times-single.txt 2>&1

  if [ $((i % 100)) -eq 0 ]; then
    echo "  评估进度: $i/500"
  fi
done

# 计算单线程统计
sort -n /tmp/eval-times-single.txt > /tmp/sorted-single.txt
single_avg=$(awk '{sum+=$1} END {print sum/NR}' /tmp/sorted-single.txt)
single_p50=$(sed -n '250p' /tmp/sorted-single.txt)
single_p95=$(sed -n '475p' /tmp/sorted-single.txt)
single_p99=$(sed -n '495p' /tmp/sorted-single.txt)
single_max=$(tail -1 /tmp/sorted-single.txt)

echo ""
echo "单线程结果:"
echo "  平均: $(echo "$single_avg * 1000" | bc | cut -d. -f1)ms"
echo "  P50:  $(echo "$single_p50 * 1000" | bc | cut -d. -f1)ms"
echo "  P95:  $(echo "$single_p95 * 1000" | bc | cut -d. -f1)ms"
echo "  P99:  $(echo "$single_p99 * 1000" | bc | cut -d. -f1)ms"
echo "  Max:  $(echo "$single_max * 1000" | bc | cut -d. -f1)ms"
echo ""

# 3. 并发性能测试（10 并发，500 总请求）
echo "步骤 3: 并发性能测试 (10 并发, 500 次评估)..."
echo "  预计耗时: 5-15 秒"

# 检查 xargs 是否支持 -P 参数
if xargs --help 2>&1 | grep -q -- '-P'; then
  # 使用 xargs 并发执行
  seq 1 500 | xargs -P 10 -I {} bash -c "
    curl -X POST '$BASE_URL/api/admin/safety/rules/evaluate' \
      -H 'Authorization: Bearer $API_TOKEN' \
      -H 'Content-Type: application/json' \
      -d '{
        \"entity_type\": \"snapshot\",
        \"entity_id\": \"test-{}\",
        \"operation\": \"delete\",
        \"properties\": {
          \"protection_level\": \"protected\",
          \"tags\": [\"test\", \"prod\"],
          \"release_channel\": \"stable\"
        }
      }' -s -w '%{time_total}\n' -o /dev/null 2>&1
  " >> /tmp/eval-times-concurrent.txt
else
  echo "  ⚠️  xargs 不支持 -P 参数，使用顺序执行"
  for i in {1..500}; do
    curl -X POST "$BASE_URL/api/admin/safety/rules/evaluate" \
      -H "Authorization: Bearer $API_TOKEN" \
      -H "Content-Type: application/json" \
      -d "{
        \"entity_type\": \"snapshot\",
        \"entity_id\": \"test-$i\",
        \"operation\": \"delete\",
        \"properties\": {
          \"protection_level\": \"protected\",
          \"tags\": [\"test\", \"prod\"],
          \"release_channel\": \"stable\"
        }
      }" -s -w "%{time_total}\n" -o /dev/null >> /tmp/eval-times-concurrent.txt 2>&1
  done
fi

# 计算并发统计
sort -n /tmp/eval-times-concurrent.txt > /tmp/sorted-concurrent.txt
concurrent_avg=$(awk '{sum+=$1} END {print sum/NR}' /tmp/sorted-concurrent.txt)
concurrent_p50=$(sed -n '250p' /tmp/sorted-concurrent.txt)
concurrent_p95=$(sed -n '475p' /tmp/sorted-concurrent.txt)
concurrent_p99=$(sed -n '495p' /tmp/sorted-concurrent.txt)
concurrent_max=$(tail -1 /tmp/sorted-concurrent.txt)

echo ""
echo "并发结果 (10 并发):"
echo "  平均: $(echo "$concurrent_avg * 1000" | bc | cut -d. -f1)ms"
echo "  P50:  $(echo "$concurrent_p50 * 1000" | bc | cut -d. -f1)ms"
echo "  P95:  $(echo "$concurrent_p95 * 1000" | bc | cut -d. -f1)ms"
echo "  P99:  $(echo "$concurrent_p99 * 1000" | bc | cut -d. -f1)ms"
echo "  Max:  $(echo "$concurrent_max * 1000" | bc | cut -d. -f1)ms"
echo ""

# 4. 清理测试规则
echo "步骤 4: 清理测试规则..."
for rule_id in "${created_rules[@]}"; do
  curl -X DELETE "$BASE_URL/api/admin/safety/rules/$rule_id" \
    -H "Authorization: Bearer $API_TOKEN" -s -o /dev/null 2>&1
done
echo "✅ 清理完成"
echo ""

# 5. 性能判定
echo "=== 性能判定 ==="
p95_ms=$(echo "$concurrent_p95 * 1000" | bc | cut -d. -f1)
p99_ms=$(echo "$concurrent_p99 * 1000" | bc | cut -d. -f1)
avg_ms=$(echo "$concurrent_avg * 1000" | bc | cut -d. -f1)

pass_count=0
fail_count=0

if [ $avg_ms -lt 100 ]; then
  echo "✅ 平均耗时达标: ${avg_ms}ms < 100ms"
  ((pass_count++))
else
  echo "❌ 平均耗时超标: ${avg_ms}ms >= 100ms"
  ((fail_count++))
fi

if [ $p95_ms -lt 150 ]; then
  echo "✅ P95 延迟达标: ${p95_ms}ms < 150ms"
  ((pass_count++))
else
  echo "❌ P95 延迟超标: ${p95_ms}ms >= 150ms"
  ((fail_count++))
fi

if [ $p99_ms -lt 250 ]; then
  echo "✅ P99 延迟达标: ${p99_ms}ms < 250ms"
  ((pass_count++))
else
  echo "❌ P99 延迟超标: ${p99_ms}ms >= 250ms"
  ((fail_count++))
fi

echo ""
echo "结束时间: $(date)"
echo "通过: $pass_count/3"
echo "失败: $fail_count/3"
echo ""

if [ $fail_count -eq 0 ]; then
  echo "🎉 性能基线测试全部通过"
  exit 0
else
  echo "⚠️  性能基线测试部分失败，建议优化:"
  echo "  - 检查数据库索引是否生效"
  echo "  - 分析慢查询日志"
  echo "  - 考虑减少规则复杂度或数量"
  exit 1
fi
