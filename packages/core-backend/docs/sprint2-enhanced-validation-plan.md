# Sprint 2: 增强验证与上线计划

> **基于审查反馈的增强版验证方案**
> **创建时间**: 2025-11-19
> **目标**: P95 延迟 < 150ms, 错误率 < 1%, 完整可观测性

---

## 📋 验证结论确认

### ✅ 交付内容自洽性验证
- ✅ 代码文件: 11 新增 + 6 修改
- ✅ API 端点: 9 个 (4 标签 + 5 规则)
- ✅ 数据库迁移: 2 个 (支持 up/down)
- ✅ Prometheus 指标: 6 个
- ✅ E2E 测试: 25 个用例
- ✅ Git 提交: 7 个，已推送

### ✅ 审查/验证体系齐备
- ✅ 代码审查清单（7 模块）
- ✅ PR 审查模板（增强版）
- ✅ Squash 提交信息（预格式化）
- ✅ Staging 验证脚本
- ✅ 推进清单（8 步）

### ⏳ 待执行验证
- ⏳ Staging 环境验证
- ⏳ 性能基线测试
- ⏳ 生产监控（24 小时）

---

## 🚀 P0 - Staging 验证增强方案

### 增强 1: 环境快照与基线

**执行前快照**:
```bash
# 1. 保存初始 Prometheus 指标
curl http://staging:9090/metrics > /tmp/metrics-baseline-before.txt

# 2. 记录数据库状态
psql -d metasheet -c "SELECT COUNT(*) FROM snapshots;" > /tmp/db-baseline.txt
psql -d metasheet -c "SELECT COUNT(*) FROM protection_rules;" >> /tmp/db-baseline.txt
psql -d metasheet -c "SELECT COUNT(*) FROM rule_execution_log;" >> /tmp/db-baseline.txt

# 3. 记录服务器初始状态
curl http://staging:8900/health | jq . > /tmp/health-baseline.txt
```

### 增强 2: 规则压力测试

**目标**: 验证规则评估性能在高负载下的表现

```bash
# 创建规则压力测试脚本
cat > /tmp/rule-stress-test.sh << 'EOF'
#!/bin/bash
API_TOKEN=$1
BASE_URL="http://staging:8900"

echo "=== 规则压力测试 ==="
echo "创建 50 条不同复杂度的规则..."

# 简单规则 (20 条)
for i in {1..20}; do
  curl -X POST "$BASE_URL/api/admin/safety/rules" \
    -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
      \"rule_name\": \"simple-rule-$i\",
      \"description\": \"Simple eq rule\",
      \"target_type\": \"snapshot\",
      \"priority\": $((100 + i)),
      \"conditions\": {
        \"all\": [{\"field\": \"protection_level\", \"operator\": \"eq\", \"value\": \"protected\"}]
      },
      \"effects\": {\"action\": \"block\", \"message\": \"Protected\"}
    }" -s -w "Status: %{http_code}, Time: %{time_total}s\n"
done

# 中等复杂度规则 (20 条)
for i in {1..20}; do
  curl -X POST "$BASE_URL/api/admin/safety/rules" \
    -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
      \"rule_name\": \"medium-rule-$i\",
      \"description\": \"Medium complexity rule\",
      \"target_type\": \"snapshot\",
      \"priority\": $((200 + i)),
      \"conditions\": {
        \"any\": [
          {\"field\": \"protection_level\", \"operator\": \"in\", \"value\": [\"protected\", \"critical\"]},
          {\"field\": \"tags\", \"operator\": \"contains\", \"value\": \"production\"}
        ]
      },
      \"effects\": {\"action\": \"elevate_risk\", \"risk_level\": \"HIGH\"}
    }" -s -w "Status: %{http_code}, Time: %{time_total}s\n"
done

# 复杂规则 (10 条)
for i in {1..10}; do
  curl -X POST "$BASE_URL/api/admin/safety/rules" \
    -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
      \"rule_name\": \"complex-rule-$i\",
      \"description\": \"Complex nested rule\",
      \"target_type\": \"snapshot\",
      \"priority\": $((300 + i)),
      \"conditions\": {
        \"all\": [
          {\"field\": \"protection_level\", \"operator\": \"ne\", \"value\": \"normal\"},
          {
            \"any\": [
              {\"field\": \"tags\", \"operator\": \"contains\", \"value\": \"production\"},
              {\"field\": \"release_channel\", \"operator\": \"eq\", \"value\": \"stable\"}
            ]
          }
        ]
      },
      \"effects\": {\"action\": \"require_approval\"}
    }" -s -w "Status: %{http_code}, Time: %{time_total}s\n"
done

echo ""
echo "=== 规则评估性能测试 (500 次) ==="
echo "开始时间: $(date)"

# 记录开始时间
start_time=$(date +%s%3N)

# 执行 500 次规则评估
for i in {1..500}; do
  curl -X POST "$BASE_URL/api/admin/safety/rules/evaluate" \
    -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
      \"entity_type\": \"snapshot\",
      \"entity_id\": \"test-snapshot-$i\",
      \"operation\": \"delete\",
      \"properties\": {
        \"protection_level\": \"protected\",
        \"tags\": [\"production\", \"tested\"],
        \"release_channel\": \"stable\"
      }
    }" -s -w "%{time_total}\n" -o /dev/null >> /tmp/rule-eval-times.txt
done

# 记录结束时间
end_time=$(date +%s%3N)
total_time=$((end_time - start_time))

echo "结束时间: $(date)"
echo "总耗时: ${total_time}ms"
echo "平均耗时: $((total_time / 500))ms"

# 计算统计数据
sort -n /tmp/rule-eval-times.txt > /tmp/sorted-times.txt
p50=$(sed -n '250p' /tmp/sorted-times.txt)
p95=$(sed -n '475p' /tmp/sorted-times.txt)
p99=$(sed -n '495p' /tmp/sorted-times.txt)
max=$(tail -1 /tmp/sorted-times.txt)

echo ""
echo "=== 延迟统计 ==="
echo "P50: ${p50}s"
echo "P95: ${p95}s"
echo "P99: ${p99}s"
echo "Max: ${max}s"

# 验证性能目标
p95_ms=$(echo "$p95 * 1000" | bc)
if [ $(echo "$p95_ms < 150" | bc) -eq 1 ]; then
  echo "✅ P95 延迟达标 (< 150ms)"
else
  echo "❌ P95 延迟超标: ${p95_ms}ms"
fi

EOF

chmod +x /tmp/rule-stress-test.sh
```

### 增强 3: 快照标签兼容性测试

```bash
# 标签兼容性测试（大小写、特殊字符、Unicode）
cat > /tmp/label-compatibility-test.sh << 'EOF'
#!/bin/bash
API_TOKEN=$1
BASE_URL="http://staging:8900"

echo "=== 快照标签兼容性测试 ==="

# 创建测试快照
SNAPSHOT_ID=$(curl -X POST "$BASE_URL/api/admin/snapshots" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"view_id": "test-view", "data": {}}' -s | jq -r '.id')

echo "测试快照 ID: $SNAPSHOT_ID"

# 测试用例 1: 大小写标签
echo "测试 1: 大小写标签..."
curl -X PUT "$BASE_URL/api/admin/snapshots/$SNAPSHOT_ID/tags" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"add": ["Production", "PRODUCTION", "production"]}' -s | jq .

# 测试用例 2: 特殊字符
echo "测试 2: 特殊字符..."
curl -X PUT "$BASE_URL/api/admin/snapshots/$SNAPSHOT_ID/tags" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"add": ["tag-with-dash", "tag_with_underscore", "tag.with.dot"]}' -s | jq .

# 测试用例 3: Unicode 字符
echo "测试 3: Unicode 字符..."
curl -X PUT "$BASE_URL/api/admin/snapshots/$SNAPSHOT_ID/tags" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"add": ["标签", "タグ", "тег"]}' -s | jq .

# 测试用例 4: 空字符串和过长标签
echo "测试 4: 边界条件..."
curl -X PUT "$BASE_URL/api/admin/snapshots/$SNAPSHOT_ID/tags" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"add\": [\"\", \"$(printf 'a%.0s' {1..256})\"]}" -s | jq .

# 设置保护级别并验证清理跳过
echo ""
echo "=== 保护快照清理跳过测试 ==="
curl -X PATCH "$BASE_URL/api/admin/snapshots/$SNAPSHOT_ID/protection" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"level": "protected"}' -s | jq .

# 设置过期时间（过去）
psql -d metasheet -c "UPDATE snapshots SET expires_at = NOW() - INTERVAL '1 day' WHERE id = '$SNAPSHOT_ID';"

# 触发清理
echo "触发清理操作..."
curl -X POST "$BASE_URL/api/admin/snapshots/cleanup" \
  -H "Authorization: Bearer $API_TOKEN" -s | jq .

# 验证快照仍存在
echo "验证受保护快照未被删除..."
curl "$BASE_URL/api/admin/snapshots/$SNAPSHOT_ID" \
  -H "Authorization: Bearer $API_TOKEN" -s | jq .

EOF

chmod +x /tmp/label-compatibility-test.sh
```

### 增强 4: PromQL 查询验证与证据收集

```bash
# PromQL 验证脚本
cat > /tmp/promql-validation.sh << 'EOF'
#!/bin/bash
PROM_URL="http://staging:9090"

echo "=== PromQL 查询验证 ==="
echo "时间: $(date)"
echo ""

# 1. 规则评估速率
echo "1. 规则评估速率（每分钟）:"
curl -s "$PROM_URL/api/v1/query?query=rate(metasheet_protection_rule_evaluations_total[5m])" | jq -r '.data.result[] | "\(.metric.rule): \(.value[1])"'
echo ""

# 2. 规则阻止速率
echo "2. 规则阻止操作速率（每分钟）:"
curl -s "$PROM_URL/api/v1/query?query=rate(metasheet_protection_rule_blocks_total[5m])" | jq -r '.data.result[] | "\(.metric.rule) [\(.metric.operation)]: \(.value[1])"'
echo ""

# 3. 保护级别分布
echo "3. 保护级别分布:"
curl -s "$PROM_URL/api/v1/query?query=metasheet_snapshot_protection_level" | jq -r '.data.result[] | "\(.metric.level): \(.value[1])"'
echo ""

# 4. 发布渠道分布
echo "4. 发布渠道分布:"
curl -s "$PROM_URL/api/v1/query?query=metasheet_snapshot_release_channel" | jq -r '.data.result[] | "\(.metric.channel): \(.value[1])"'
echo ""

# 5. Top 5 标签
echo "5. Top 5 最常用标签:"
curl -s "$PROM_URL/api/v1/query?query=topk(5, metasheet_snapshot_tags_total)" | jq -r '.data.result[] | "\(.metric.tag): \(.value[1])"'
echo ""

# 6. 受保护快照跳过计数
echo "6. 受保护快照清理跳过计数:"
curl -s "$PROM_URL/api/v1/query?query=metasheet_snapshot_protected_skipped_total" | jq -r '.data.result[] | "\(.value[1])"'
echo ""

# 7. P50/P95/P99 延迟（如果有 histogram）
echo "7. 规则评估延迟分布:"
echo "P50:"
curl -s "$PROM_URL/api/v1/query?query=histogram_quantile(0.50, rate(metasheet_rule_evaluation_duration_bucket[5m]))" | jq -r '.data.result[0].value[1] // "N/A"'
echo "P95:"
curl -s "$PROM_URL/api/v1/query?query=histogram_quantile(0.95, rate(metasheet_rule_evaluation_duration_bucket[5m]))" | jq -r '.data.result[0].value[1] // "N/A"'
echo "P99:"
curl -s "$PROM_URL/api/v1/query?query=histogram_quantile(0.99, rate(metasheet_rule_evaluation_duration_bucket[5m]))" | jq -r '.data.result[0].value[1] // "N/A"'

EOF

chmod +x /tmp/promql-validation.sh
```

---

## 🎯 P1 - 性能基线测试方案

### 目标性能指标
- **平均耗时**: < 100ms
- **P50 延迟**: < 50ms
- **P95 延迟**: < 150ms
- **P99 延迟**: < 250ms
- **最大并发**: 10 QPS 无降级

### 性能基线测试脚本

```bash
cat > scripts/performance-baseline-test.sh << 'EOF'
#!/bin/bash
set -e

API_TOKEN=$1
BASE_URL=${2:-"http://localhost:8900"}

if [ -z "$API_TOKEN" ]; then
  echo "Usage: $0 <API_TOKEN> [BASE_URL]"
  exit 1
fi

echo "=== Sprint 2 性能基线测试 ==="
echo "目标: 平均 < 100ms, P95 < 150ms, P99 < 250ms"
echo "BASE_URL: $BASE_URL"
echo ""

# 1. 创建测试规则（N=200）
echo "步骤 1: 创建 200 条测试规则..."
for i in {1..200}; do
  complexity=$((i % 3))
  case $complexity in
    0) # 简单规则
      CONDITIONS='{"all": [{"field": "protection_level", "operator": "eq", "value": "protected"}]}'
      ;;
    1) # 中等复杂度
      CONDITIONS='{"any": [{"field": "tags", "operator": "contains", "value": "test"}, {"field": "protection_level", "operator": "ne", "value": "normal"}]}'
      ;;
    2) # 复杂规则
      CONDITIONS='{"all": [{"field": "protection_level", "operator": "in", "value": ["protected", "critical"]}, {"any": [{"field": "tags", "operator": "contains", "value": "prod"}, {"field": "release_channel", "operator": "eq", "value": "stable"}]}]}'
      ;;
  esac

  curl -X POST "$BASE_URL/api/admin/safety/rules" \
    -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
      \"rule_name\": \"perf-test-rule-$i\",
      \"description\": \"Performance test rule\",
      \"target_type\": \"snapshot\",
      \"priority\": $((1000 - i)),
      \"conditions\": $CONDITIONS,
      \"effects\": {\"action\": \"block\", \"message\": \"Test\"}
    }" -s -o /dev/null -w "%{http_code}\n" > /dev/null

  if [ $((i % 50)) -eq 0 ]; then
    echo "  创建进度: $i/200"
  fi
done

echo "✅ 规则创建完成"
echo ""

# 2. 单线程性能测试（M=500）
echo "步骤 2: 单线程性能测试 (500 次评估)..."
rm -f /tmp/eval-times-single.txt

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
    }" -s -w "%{time_total}\n" -o /dev/null >> /tmp/eval-times-single.txt
done

# 计算单线程统计
sort -n /tmp/eval-times-single.txt > /tmp/sorted-single.txt
single_avg=$(awk '{sum+=$1} END {print sum/NR}' /tmp/sorted-single.txt)
single_p50=$(sed -n '250p' /tmp/sorted-single.txt)
single_p95=$(sed -n '475p' /tmp/sorted-single.txt)
single_p99=$(sed -n '495p' /tmp/sorted-single.txt)
single_max=$(tail -1 /tmp/sorted-single.txt)

echo "单线程结果:"
echo "  平均: $(echo "$single_avg * 1000" | bc | cut -d. -f1)ms"
echo "  P50:  $(echo "$single_p50 * 1000" | bc | cut -d. -f1)ms"
echo "  P95:  $(echo "$single_p95 * 1000" | bc | cut -d. -f1)ms"
echo "  P99:  $(echo "$single_p99 * 1000" | bc | cut -d. -f1)ms"
echo "  Max:  $(echo "$single_max * 1000" | bc | cut -d. -f1)ms"
echo ""

# 3. 并发性能测试（10 并发，500 总请求）
echo "步骤 3: 并发性能测试 (10 并发, 500 次评估)..."
rm -f /tmp/eval-times-concurrent.txt

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
    }' -s -w '%{time_total}\n' -o /dev/null >> /tmp/eval-times-concurrent.txt
"

# 计算并发统计
sort -n /tmp/eval-times-concurrent.txt > /tmp/sorted-concurrent.txt
concurrent_avg=$(awk '{sum+=$1} END {print sum/NR}' /tmp/sorted-concurrent.txt)
concurrent_p50=$(sed -n '250p' /tmp/sorted-concurrent.txt)
concurrent_p95=$(sed -n '475p' /tmp/sorted-concurrent.txt)
concurrent_p99=$(sed -n '495p' /tmp/sorted-concurrent.txt)
concurrent_max=$(tail -1 /tmp/sorted-concurrent.txt)

echo "并发结果 (10 并发):"
echo "  平均: $(echo "$concurrent_avg * 1000" | bc | cut -d. -f1)ms"
echo "  P50:  $(echo "$concurrent_p50 * 1000" | bc | cut -d. -f1)ms"
echo "  P95:  $(echo "$concurrent_p95 * 1000" | bc | cut -d. -f1)ms"
echo "  P99:  $(echo "$concurrent_p99 * 1000" | bc | cut -d. -f1)ms"
echo "  Max:  $(echo "$concurrent_max * 1000" | bc | cut -d. -f1)ms"
echo ""

# 4. 性能判定
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
echo "通过: $pass_count/3"
echo "失败: $fail_count/3"

if [ $fail_count -eq 0 ]; then
  echo "🎉 性能基线测试全部通过"
  exit 0
else
  echo "⚠️  性能基线测试部分失败，建议优化"
  exit 1
fi

EOF

chmod +x scripts/performance-baseline-test.sh
```

---

## 📊 P2 - 上线前回滚与监控方案

### 回滚开关配置

**环境变量控制** (`.env`):
```bash
# 功能开关（紧急回退用）
SAFETY_RULES_ENABLED=true          # 规则引擎总开关
SAFETY_GUARD_ENABLED=true          # SafetyGuard 总开关
SNAPSHOT_LABELS_ENABLED=true       # 标签系统开关
```

**数据库回滚步骤**:
```bash
# 1. 禁用功能
export SAFETY_RULES_ENABLED=false

# 2. 回滚迁移
npm run migrate:down  # 回滚 Migration 2
npm run migrate:down  # 回滚 Migration 1

# 3. 验证回滚
psql -d metasheet -c "SELECT table_name FROM information_schema.tables WHERE table_name IN ('protection_rules', 'rule_execution_log');"
# 应返回 0 行

# 4. 重启服务
systemctl restart metasheet
```

### 24 小时监控关注点

#### 关键告警（P0 - 立即响应）
```yaml
alerts:
  - name: RuleEvaluationP95High
    query: histogram_quantile(0.95, rate(metasheet_rule_evaluation_duration_bucket[5m])) > 0.200
    duration: 10m
    severity: critical
    action: "规则评估 P95 > 200ms 持续 10 分钟 → 立即回滚"

  - name: RuleEvaluationErrorRate
    query: rate(metasheet_protection_rule_eval_error_total[5m]) / rate(metasheet_protection_rule_evaluations_total[5m]) > 0.01
    duration: 5m
    severity: critical
    action: "错误率 > 1% 持续 5 分钟 → 立即回滚"

  - name: DatabaseDeadlock
    query: pg_stat_database_deadlocks > 0
    duration: 1m
    severity: critical
    action: "数据库死锁 → 检查索引与查询，考虑回滚"
```

#### 业务指标（P1 - 密切关注）
```yaml
monitors:
  - metric: metasheet_protection_rule_blocks_total
    check: "短时间激增（> 10x 基线）"
    reason: "规则配置错误或误阻止"
    action: "审查规则配置，必要时禁用特定规则"

  - metric: metasheet_snapshot_protected_skipped_total
    check: "长时间为 0"
    reason: "保护机制未生效或标签未正确写入"
    action: "验证标签写入流程和清理逻辑"

  - metric: metasheet_snapshot_tags_total
    check: "标签数量异常增长"
    reason: "标签去重失败或重复计数"
    action: "检查标签 TopN 面板去重逻辑"
```

#### 性能指标（P1 - 趋势分析）
```yaml
trends:
  - metric: rule_evaluation_duration
    check: "与部署时间相关的延迟升高"
    action: "分析慢查询，优化索引策略"

  - metric: snapshot_query_performance
    check: "标签查询延迟"
    action: "验证 GIN 索引效果"

  - metric: database_connections
    check: "连接池耗尽"
    action: "检查规则评估是否未释放连接"
```

---

## 🔧 额外增强建议

### 1. 错误监控指标

**新增指标**:
```typescript
// src/metrics/metrics.ts
export const protectionRuleEvalErrorTotal = new promClient.Counter({
  name: 'metasheet_protection_rule_eval_error_total',
  help: 'Total number of protection rule evaluation errors',
  labelNames: ['rule', 'error_type']
});
```

**使用位置**:
```typescript
// src/services/ProtectionRuleService.ts
try {
  // 规则评估逻辑
} catch (error) {
  protectionRuleEvalErrorTotal.labels(ruleName, error.name).inc();
  throw error;
}
```

### 2. 标签 TopN 去重验证

**Grafana 面板查询修正**:
```promql
# 正确的去重查询（按 tag 聚合）
sum by (tag) (metasheet_snapshot_tags_total)

# 或使用 count
count by (tag) (metasheet_snapshot_tags_total > 0)
```

### 3. 只读标签保护测试

```bash
# 测试场景：尝试修改受保护快照的标签应失败
cat > /tmp/readonly-protection-test.sh << 'EOF'
#!/bin/bash
API_TOKEN=$1
BASE_URL="http://staging:8900"

# 创建快照并设置为 protected
SNAPSHOT_ID=$(curl -X POST "$BASE_URL/api/admin/snapshots" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"view_id": "test", "data": {}}' -s | jq -r '.id')

curl -X PATCH "$BASE_URL/api/admin/snapshots/$SNAPSHOT_ID/protection" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"level": "critical"}' -s > /dev/null

# 创建阻止标签修改的规则
curl -X POST "$BASE_URL/api/admin/safety/rules" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "rule_name": "block-protected-label-modification",
    "target_type": "snapshot",
    "conditions": {
      "all": [
        {"field": "protection_level", "operator": "eq", "value": "critical"}
      ]
    },
    "effects": {"action": "block", "message": "Cannot modify critical snapshots"}
  }' -s > /dev/null

# 尝试修改标签（应失败）
echo "尝试修改 critical 快照的标签..."
response=$(curl -X PUT "$BASE_URL/api/admin/snapshots/$SNAPSHOT_ID/tags" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"add": ["new-tag"]}' -s -w "\n%{http_code}")

http_code=$(echo "$response" | tail -1)
if [ "$http_code" = "403" ]; then
  echo "✅ 只读保护生效: HTTP 403"
else
  echo "❌ 只读保护失败: HTTP $http_code"
fi

EOF

chmod +x /tmp/readonly-protection-test.sh
```

---

## 📋 PR 审查分工建议

| 模块 | 责任人 | 审查重点 | 工时估计 |
|------|--------|----------|----------|
| **DB 专家** | ________ | 迁移文件 + 索引策略 + 回滚可行性 | 2-3 小时 |
| **后端/规则专家** | ________ | ProtectionRuleService + SafetyGuard 异步调用 | 3-4 小时 |
| **安全/API 专家** | ________ | 路由认证/鉴权/审计/限流 | 2 小时 |
| **可观测性专家** | ________ | 指标 cardinality + Grafana 面板一致性 | 1-2 小时 |
| **QA** | ________ | E2E 测试结构与边界用例覆盖 | 2 小时 |

**总计**: 10-13 小时（可并行）

---

## 🚀 最终执行顺序

### 阶段 1: Staging 验证（1-2 天）
1. ✅ 部署到 staging
2. ✅ 运行标准验证脚本: `./scripts/verify-sprint2-staging.sh`
3. ✅ 执行增强验证:
   - `/tmp/rule-stress-test.sh`
   - `/tmp/label-compatibility-test.sh`
   - `/tmp/readonly-protection-test.sh`
4. ✅ 运行性能基线测试: `./scripts/performance-baseline-test.sh`
5. ✅ 执行 PromQL 验证: `/tmp/promql-validation.sh`
6. ✅ 收集所有证据并填写验证结果模板

### 阶段 2: PR 准备（0.5 天）
7. ✅ 附加性能与 PromQL 查询证据到 PR
8. ✅ 更新审查模板勾选状态
9. ✅ `gh pr ready` 标记 Ready for Review

### 阶段 3: 代码审查（1-2 天）
10. ✅ 分配审查员到 5 个专业领域
11. ✅ 系统化审查（使用审查模板）
12. ✅ 收集 ≥2 个 APPROVED

### 阶段 4: 合并部署（0.5 天）
13. ✅ Squash merge（使用预制提交信息）
14. ✅ CHANGELOG 版本落签 (v2.1.0)
15. ✅ 启动 24 小时监控窗口

### 阶段 5: 生产监控（1 天）
16. ✅ 记录首次 6 指标基线
17. ✅ 监控规则命中频率
18. ✅ 验证无告警触发
19. ✅ 完成监控报告

---

**总预计时间**: 4-6 天（含并行审查）

**关键路径**: Staging 验证 → PR Ready → 审查 → 合并 → 监控

**成功标准**:
- ✅ 所有验证通过（标准 + 增强）
- ✅ 性能基线达标（P95 < 150ms）
- ✅ ≥2 个 APPROVED 审查
- ✅ 24 小时监控无告警
