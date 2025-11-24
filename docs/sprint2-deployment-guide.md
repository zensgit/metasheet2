# Sprint 2: Snapshot Protection System - 部署指南

## 概览

本文档提供 Sprint 2: Snapshot Protection System 的完整部署和验证步骤。

**实施日期**: 2025-01-19
**状态**: ✅ 开发完成，准备部署
**版本**: 1.0.0

## 前置要求

### 环境要求

- Node.js >= 18.x
- PostgreSQL >= 14.x
- pnpm >= 8.x
- Grafana >= 9.x (可选，用于仪表板)
- Prometheus (可选，用于指标收集)

### 数据库访问

确保有以下环境变量：

```bash
DATABASE_URL=postgresql://user:password@host:port/database
```

## 部署步骤

### 第一步：代码集成验证

1. **检查所有文件**

```bash
cd packages/core-backend

# 检查新文件是否存在
ls -la src/db/migrations/20251117000001_add_snapshot_labels.ts
ls -la src/db/migrations/20251117000002_create_protection_rules.ts
ls -la src/services/ProtectionRuleService.ts
ls -la src/routes/snapshot-labels.ts
ls -la src/routes/protection-rules.ts
ls -la grafana/dashboards/snapshot-protection.json
ls -la tests/integration/snapshot-protection.test.ts
```

2. **TypeScript 编译检查**

```bash
# Sprint 2 特定文件编译检查
npx tsc --noEmit src/services/ProtectionRuleService.ts
npx tsc --noEmit src/routes/snapshot-labels.ts
npx tsc --noEmit src/routes/protection-rules.ts

# 如果有错误，修复后再继续
```

### 第二步：数据库迁移

⚠️ **重要**: 在生产环境执行前，先在开发/测试环境验证

1. **查看待执行的迁移**

```bash
# 查看待执行的迁移列表
npm run db:migrate:status

# 或手动检查
psql $DATABASE_URL -c "SELECT * FROM migrations ORDER BY executed_at DESC LIMIT 5;"
```

2. **执行数据库迁移**

```bash
# 方式1: 使用项目迁移命令（如果有）
npm run db:migrate

# 方式2: 使用 Kysely 迁移工具
npx kysely migrate:latest

# 方式3: 手动执行（不推荐）
# psql $DATABASE_URL < src/db/migrations/20251117000001_add_snapshot_labels.ts
# psql $DATABASE_URL < src/db/migrations/20251117000002_create_protection_rules.ts
```

3. **验证迁移结果**

```bash
# 验证 snapshots 表新增列
psql $DATABASE_URL -c "\d snapshots"

# 应该看到:
# - tags text[]
# - protection_level text
# - release_channel text

# 验证 protection_rules 表
psql $DATABASE_URL -c "\d protection_rules"

# 验证索引
psql $DATABASE_URL -c "\di idx_snapshots_tags"
psql $DATABASE_URL -c "\di idx_protection_rules_conditions"
```

### 第三步：应用部署

1. **安装依赖**

```bash
pnpm install
```

2. **构建应用**

```bash
npm run build
```

3. **运行测试**

```bash
# 单元测试
npm run test

# Sprint 2 集成测试
npx vitest tests/integration/snapshot-protection.test.ts

# 所有集成测试
npm run test:integration
```

4. **启动应用**

```bash
# 开发模式
npm run dev

# 生产模式
npm run start
```

### 第四步：验证部署

1. **健康检查**

```bash
# 检查应用是否启动
curl http://localhost:8900/health

# 预期输出: {"status":"ok","uptime":...}
```

2. **指标端点检查**

```bash
# 检查 Prometheus 指标
curl http://localhost:8900/metrics/prom | grep metasheet_snapshot

# 应该看到:
# - metasheet_snapshot_tags_total
# - metasheet_snapshot_protection_level
# - metasheet_snapshot_release_channel
# - metasheet_protection_rule_evaluations_total
# - metasheet_protection_rule_blocks_total
# - metasheet_snapshot_protected_skipped_total
```

3. **API 端点测试**

```bash
# 测试 Protection Rules API
curl -X GET http://localhost:8900/api/admin/safety/rules \
  -H "x-user-id: admin"

# 预期: {"success":true,"rules":[],"count":0}

# 创建测试规则
curl -X POST http://localhost:8900/api/admin/safety/rules \
  -H "Content-Type: application/json" \
  -H "x-user-id: admin" \
  -d '{
    "rule_name": "Test Protection Rule",
    "description": "Test rule for deployment verification",
    "target_type": "snapshot",
    "conditions": {
      "type": "all",
      "conditions": [
        {
          "field": "tags",
          "operator": "contains",
          "value": "test"
        }
      ]
    },
    "effects": {
      "action": "block",
      "message": "Test blocked"
    },
    "priority": 100,
    "is_active": true
  }'

# 预期: {"success":true,"rule":{...},"message":"Protection rule created successfully"}
```

4. **Snapshot Labels API 测试**

```bash
# 创建测试快照（假设有快照ID）
SNAPSHOT_ID="test_snapshot_id"

# 添加标签
curl -X PUT http://localhost:8900/api/admin/snapshots/$SNAPSHOT_ID/tags \
  -H "Content-Type: application/json" \
  -H "x-user-id: admin" \
  -d '{"add": ["production", "v1.0.0"]}'

# 设置保护级别
curl -X PATCH http://localhost:8900/api/admin/snapshots/$SNAPSHOT_ID/protection \
  -H "Content-Type: application/json" \
  -H "x-user-id: admin" \
  -d '{"level": "protected"}'

# 设置发布通道
curl -X PATCH http://localhost:8900/api/admin/snapshots/$SNAPSHOT_ID/release-channel \
  -H "Content-Type: application/json" \
  -H "x-user-id: admin" \
  -d '{"channel": "stable"}'
```

### 第五步：Grafana 仪表板设置

1. **导入仪表板**

```bash
# 方式1: 自动配置（如果已配置）
# 将文件复制到 Grafana provisioning 目录
cp grafana/dashboards/snapshot-protection.json \
   /etc/grafana/provisioning/dashboards/

# 重启 Grafana
systemctl restart grafana-server
```

2. **手动导入**

- 打开 Grafana UI: `http://localhost:3000`
- 导航到: Dashboards → Import
- 上传文件: `grafana/dashboards/snapshot-protection.json`
- 选择 Prometheus 数据源
- 点击 Import

3. **验证仪表板**

访问仪表板后应该看到：
- ✅ Protected Snapshots Count
- ✅ Protected Skipped (24h)
- ✅ Rule Evaluations (1h)
- ✅ Operations Blocked (1h)
- ✅ Protection Level Distribution (Pie)
- ✅ Release Channel Distribution (Pie)
- ✅ Top 10 Snapshot Tags (Bar)
- ✅ Rule Evaluation Rate (Time Series)
- ✅ Operations Blocked by Rules (Time Series)
- ✅ Protected Snapshots Skipped (Time Series)

## 功能验证

### 场景 1: 保护规则创建和评估

```bash
# 1. 创建阻止删除生产快照的规则
curl -X POST http://localhost:8900/api/admin/safety/rules \
  -H "Content-Type: application/json" \
  -H "x-user-id: admin" \
  -d '{
    "rule_name": "Block Production Snapshot Deletion",
    "description": "Prevent deletion of production snapshots",
    "target_type": "snapshot",
    "conditions": {
      "type": "all",
      "conditions": [
        {"field": "tags", "operator": "contains", "value": "production"}
      ]
    },
    "effects": {
      "action": "block",
      "message": "Cannot delete production snapshots"
    }
  }'

# 2. 干运行评估
curl -X POST http://localhost:8900/api/admin/safety/rules/evaluate \
  -H "Content-Type: application/json" \
  -H "x-user-id: admin" \
  -d '{
    "entity_type": "snapshot",
    "entity_id": "snap_123",
    "operation": "delete",
    "properties": {
      "tags": ["production", "v1.0.0"],
      "protection_level": "protected"
    }
  }'

# 预期结果: matched=true, action=block
```

### 场景 2: 快照标签管理

```bash
# 假设有快照 ID
SNAPSHOT_ID="snap_456"

# 1. 添加多个标签
curl -X PUT http://localhost:8900/api/admin/snapshots/$SNAPSHOT_ID/tags \
  -H "Content-Type: application/json" \
  -H "x-user-id: admin" \
  -d '{"add": ["production", "stable", "v2.0.0"]}'

# 2. 设置为关键保护级别
curl -X PATCH http://localhost:8900/api/admin/snapshots/$SNAPSHOT_ID/protection \
  -H "Content-Type: application/json" \
  -H "x-user-id: admin" \
  -d '{"level": "critical"}'

# 3. 设置发布通道
curl -X PATCH http://localhost:8900/api/admin/snapshots/$SNAPSHOT_ID/release-channel \
  -H "Content-Type: application/json" \
  -H "x-user-id: admin" \
  -d '{"channel": "stable"}'

# 4. 查询带production标签的快照
curl http://localhost:8900/api/admin/snapshots?tags=production \
  -H "x-user-id: admin"
```

### 场景 3: 受保护快照清理验证

```bash
# 1. 运行清理操作（应跳过受保护的快照）
curl -X POST http://localhost:8900/api/admin/snapshots/cleanup \
  -H "Content-Type: application/json" \
  -H "x-user-id: admin" \
  -d '{"dryRun": true}'

# 预期响应:
# {
#   "success": true,
#   "message": "Cleanup completed: X snapshots deleted, Y protected skipped",
#   "deleted": X,
#   "skipped": Y,
#   "freedBytes": Z
# }

# 2. 检查指标
curl http://localhost:8900/metrics/prom | grep metasheet_snapshot_protected_skipped_total
```

## 监控和告警

### 关键指标监控

1. **保护规则命中率**

```promql
# 每分钟规则评估率
rate(metasheet_protection_rule_evaluations_total[5m])

# 规则阻止操作率
rate(metasheet_protection_rule_blocks_total[5m])
```

2. **受保护快照统计**

```promql
# 受保护快照总数
sum(metasheet_snapshot_protection_level{level="protected"}) +
sum(metasheet_snapshot_protection_level{level="critical"})

# 清理时跳过的受保护快照
increase(metasheet_snapshot_protected_skipped_total[24h])
```

3. **标签使用情况**

```promql
# Top 10 最常用标签
topk(10, metasheet_snapshot_tags_total)
```

### 推荐告警规则

```yaml
# prometheus-alerts.yml
groups:
  - name: snapshot_protection
    interval: 1m
    rules:
      # 高阻止率告警
      - alert: HighProtectionRuleBlockRate
        expr: rate(metasheet_protection_rule_blocks_total[5m]) > 10
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High protection rule block rate"
          description: "Protection rules are blocking >10 operations/min"

      # 受保护快照数量异常
      - alert: TooManyProtectedSnapshots
        expr: |
          (sum(metasheet_snapshot_protection_level{level="protected"}) +
           sum(metasheet_snapshot_protection_level{level="critical"})) > 1000
        for: 10m
        labels:
          severity: info
        annotations:
          summary: "Large number of protected snapshots"
          description: "More than 1000 snapshots are protected"
```

## 回滚计划

如果遇到问题，按以下步骤回滚：

### 1. 应用回滚

```bash
# 停止应用
npm run stop

# 切换到上一版本
git checkout <previous_commit>

# 重新构建和启动
npm run build
npm run start
```

### 2. 数据库回滚

⚠️ **警告**: 数据库回滚会删除所有新数据

```bash
# 回滚迁移（如果迁移工具支持）
npm run db:migrate:down

# 或手动执行 down migration
psql $DATABASE_URL -c "
  ALTER TABLE snapshots
    DROP COLUMN IF EXISTS tags,
    DROP COLUMN IF EXISTS protection_level,
    DROP COLUMN IF EXISTS release_channel;

  DROP TABLE IF EXISTS rule_execution_log;
  DROP TABLE IF EXISTS protection_rules;
"
```

### 3. 临时禁用功能

如果只想暂时禁用而不回滚：

```typescript
// 在 src/routes/admin-routes.ts 中注释掉
// router.use('/snapshots', snapshotLabelsRouter);
// router.use('/safety/rules', protectionRulesRouter);
```

## 故障排查

### 问题 1: 迁移失败

**症状**: 数据库迁移执行失败

**排查步骤**:
```bash
# 检查数据库连接
psql $DATABASE_URL -c "SELECT version();"

# 检查迁移历史
psql $DATABASE_URL -c "SELECT * FROM migrations ORDER BY executed_at DESC;"

# 查看详细错误
npm run db:migrate -- --verbose
```

### 问题 2: API 返回 404

**症状**: 新端点返回 404 Not Found

**排查步骤**:
```bash
# 检查路由注册
grep -n "snapshot-labels\|protection-rules" src/routes/admin-routes.ts

# 检查应用日志
tail -f logs/application.log | grep -i "route\|snapshot\|protection"

# 验证路由是否加载
curl http://localhost:8900/api/admin/safety/rules
```

### 问题 3: 指标不显示

**症状**: Grafana 仪表板没有数据

**排查步骤**:
```bash
# 1. 检查 Prometheus 端点
curl http://localhost:8900/metrics/prom | head -20

# 2. 检查指标导出
curl http://localhost:8900/metrics/prom | grep metasheet_snapshot

# 3. 验证 Prometheus 配置
curl http://prometheus:9090/api/v1/targets | jq '.data.activeTargets[] | select(.labels.job=="metasheet")'

# 4. 手动触发指标
# 执行一些操作生成指标数据
curl -X POST http://localhost:8900/api/admin/safety/rules/evaluate ...
```

### 问题 4: TypeScript 编译错误

**症状**: 构建时出现 TypeScript 错误

**已知问题**: Logger 导入大小写问题已修复

**排查步骤**:
```bash
# 检查特定文件
npx tsc --noEmit src/services/ProtectionRuleService.ts
npx tsc --noEmit src/services/SnapshotService.ts

# 如果还有错误，检查导入路径
grep -r "from '../core/Logger'" src/
# 应该全部是小写: '../core/logger'
```

## 性能优化建议

### 数据库优化

1. **定期分析表统计**

```sql
ANALYZE snapshots;
ANALYZE protection_rules;
ANALYZE rule_execution_log;
```

2. **监控索引使用**

```sql
-- 检查索引使用情况
SELECT
  schemaname,
  tablename,
  indexname,
  idx_scan,
  idx_tup_read,
  idx_tup_fetch
FROM pg_stat_user_indexes
WHERE tablename IN ('snapshots', 'protection_rules', 'rule_execution_log')
ORDER BY idx_scan DESC;
```

3. **规则执行日志清理**

```sql
-- 定期清理旧日志（例如，保留最近30天）
DELETE FROM rule_execution_log
WHERE executed_at < NOW() - INTERVAL '30 days';
```

### 应用优化

1. **规则评估缓存**（未来增强）

```typescript
// 可以考虑添加规则评估结果缓存
// 对于相同的entity_id + operation组合
```

2. **批量操作**

```typescript
// 批量添加/删除标签
// 批量设置保护级别
```

## 下一步

1. ✅ 验证所有部署步骤
2. ✅ 执行功能验证测试
3. ✅ 配置监控和告警
4. ✅ 培训团队使用新功能
5. ⏸️ 收集用户反馈
6. ⏸️ 规划 Sprint 3 增强功能

## 联系和支持

如有问题，请联系：

- **开发团队**: [Team Email]
- **文档**: `docs/sprint2-snapshot-protection-implementation.md`
- **Issue Tracker**: [Project Repository]

---

**文档版本**: 1.0
**最后更新**: 2025-01-19
**状态**: 准备部署
