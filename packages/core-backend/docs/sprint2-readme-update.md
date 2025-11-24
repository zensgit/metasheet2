# Sprint 2: README 更新内容

以下内容可追加到 README.md 相应章节中。

---

## Sprint 2: Snapshot Protection System（快照保护系统）

### 功能概览

Sprint 2 引入了完整的快照保护与规则引擎系统，提供：

- **快照标签管理**：为快照添加 tags（标签数组）、protection_level（保护级别）、release_channel（发布渠道）
- **保护规则引擎**：基于 JSONB 的灵活条件匹配与效果应用系统（block/elevate_risk/require_approval）
- **SafetyGuard 集成**：规则引擎与现有安全防护系统深度集成，支持动态风险评估
- **增强的可观测性**：6 个新增 Prometheus 指标 + 专用 Grafana 仪表板
- **审计日志**：所有标签操作和规则评估均记录审计轨迹

### 新增 API 端点

#### Snapshot Labels API (`/api/admin/snapshots`)

```http
# 添加/移除标签
PUT /api/admin/snapshots/:id/tags
Content-Type: application/json
Authorization: Bearer {token}

{
  "add": ["production", "v2.0"],
  "remove": ["beta"]
}

# 设置保护级别
PATCH /api/admin/snapshots/:id/protection
Content-Type: application/json

{
  "level": "protected"  // normal | protected | critical
}

# 设置发布渠道
PATCH /api/admin/snapshots/:id/release-channel
Content-Type: application/json

{
  "channel": "stable"  // stable | canary | beta | experimental
}

# 按标签查询快照
GET /api/admin/snapshots?tags=production&protection_level=protected
```

#### Protection Rules API (`/api/admin/safety/rules`)

```http
# 创建保护规则
POST /api/admin/safety/rules
Content-Type: application/json
Authorization: Bearer {token}

{
  "rule_name": "block-production-delete",
  "description": "阻止删除生产环境快照",
  "target_type": "snapshot",
  "conditions": {
    "all": [
      {"field": "tags", "operator": "contains", "value": "production"}
    ]
  },
  "effects": {
    "action": "block",
    "message": "无法删除生产环境快照"
  },
  "priority": 100
}

# 列出所有规则
GET /api/admin/safety/rules?target_type=snapshot&is_active=true

# 获取单个规则
GET /api/admin/safety/rules/:id

# 更新规则
PATCH /api/admin/safety/rules/:id
Content-Type: application/json

{
  "priority": 200,
  "is_active": false
}

# 删除规则
DELETE /api/admin/safety/rules/:id

# 评估规则（dry-run）
POST /api/admin/safety/rules/evaluate
Content-Type: application/json

{
  "entity_type": "snapshot",
  "entity_id": "snapshot-123",
  "operation": "delete",
  "properties": {
    "tags": ["production"],
    "protection_level": "critical"
  }
}
```

### 数据库迁移

Sprint 2 新增 2 个数据库迁移：

1. **20251117000001_add_snapshot_labels.ts** - 为 snapshots 表添加标签列
   - `tags TEXT[]` - 标签数组，GIN 索引
   - `protection_level TEXT` - 保护级别（normal/protected/critical）
   - `release_channel TEXT` - 发布渠道（stable/canary/beta/experimental）
   - CHECK 约束确保枚举值有效性

2. **20251117000002_create_protection_rules.ts** - 创建保护规则表
   - `protection_rules` - 规则定义表（JSONB 条件与效果）
   - `rule_execution_log` - 规则执行日志表（审计轨迹）
   - GIN 索引用于高效 JSONB 查询

### 规则引擎能力

#### 支持的条件操作符

- **比较**: `eq`, `ne`, `gt`, `lt`, `gte`, `lte`
- **包含**: `contains`, `not_contains`, `in`, `not_in`
- **存在性**: `exists`, `not_exists`

#### 条件逻辑组合

```json
{
  "all": [   // AND 逻辑（所有条件必须满足）
    {"field": "tags", "operator": "contains", "value": "production"},
    {"field": "protection_level", "operator": "eq", "value": "critical"}
  ],
  "any": [   // OR 逻辑（任一条件满足）
    {"field": "tags", "operator": "contains", "value": "stable"},
    {"field": "release_channel", "operator": "eq", "value": "stable"}
  ],
  "not": {   // NOT 逻辑（条件不满足）
    "field": "tags",
    "operator": "contains",
    "value": "deprecated"
  }
}
```

#### 效果类型

- **allow**: 允许操作（默认行为）
- **block**: 阻止操作并返回错误
- **elevate_risk**: 提升风险级别（LOW/MEDIUM/HIGH/CRITICAL）
- **require_approval**: 要求双重确认

### Prometheus 指标

Sprint 2 新增 6 个指标用于监控快照保护系统：

```promql
# 标签使用统计（Counter）
metasheet_snapshot_tags_total{tag="production"}

# 保护级别分布（Gauge）
metasheet_snapshot_protection_level{level="protected"}

# 发布渠道分布（Gauge）
metasheet_snapshot_release_channel{channel="stable"}

# 规则评估总数（Counter）
metasheet_protection_rule_evaluations_total{rule="block-production-delete", result="matched"}

# 规则阻止操作总数（Counter）
metasheet_protection_rule_blocks_total{rule="block-production-delete", operation="delete"}

# 清理时跳过的受保护快照数（Counter）
metasheet_snapshot_protected_skipped_total
```

### Grafana 仪表板

新增 `grafana/dashboards/snapshot-protection.json` 仪表板，包含 10 个面板：

- 保护级别分布（饼图）
- 发布渠道分布（饼图）
- Top 10 使用标签（条形图）
- 规则评估速率（时序图）
- 操作阻止趋势（时序图）
- 受保护快照跳过统计（时序图）
- 受保护快照总数（单值面板）
- 活跃规则数（单值面板）
- 规则评估性能（时序图）
- 标签使用热力图（热力图）

### 部署指南

详细部署步骤请参考：

- **实施文档**: `docs/sprint2-snapshot-protection-implementation.md`
- **部署指南**: `docs/sprint2-deployment-guide.md`
- **代码审查清单**: `docs/sprint2-code-review-checklist.md`
- **验证脚本**: `scripts/verify-sprint2-staging.sh`

### 快速开始

```bash
# 1. 运行数据库迁移
npm run migrate

# 2. 启动服务器
npm run dev

# 3. 创建保护规则（示例）
curl -X POST http://localhost:8900/api/admin/safety/rules \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -d '{
    "rule_name": "protect-production-snapshots",
    "target_type": "snapshot",
    "conditions": {
      "all": [{"field": "tags", "operator": "contains", "value": "production"}]
    },
    "effects": {
      "action": "elevate_risk",
      "risk_level": "HIGH",
      "message": "生产环境快照需要高风险评估"
    },
    "priority": 100,
    "created_by": "admin"
  }'

# 4. 为快照添加标签
curl -X PUT http://localhost:8900/api/admin/snapshots/{snapshot-id}/tags \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -d '{
    "add": ["production", "v2.1.0"]
  }'

# 5. 设置保护级别
curl -X PATCH http://localhost:8900/api/admin/snapshots/{snapshot-id}/protection \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -d '{
    "level": "protected"
  }'

# 6. 导入 Grafana 仪表板
# 在 Grafana UI 中导入 grafana/dashboards/snapshot-protection.json

# 7. 运行集成测试
npm test -- tests/integration/snapshot-protection.test.ts

# 8. 运行 staging 验证脚本
chmod +x scripts/verify-sprint2-staging.sh
./scripts/verify-sprint2-staging.sh {API_TOKEN}
```

### 安全注意事项

- 所有管理 API 端点都需要 Bearer token 认证
- 规则评估过程记录在 `rule_execution_log` 表中进行审计
- 受保护的快照（protection_level = protected 或 critical）在自动清理时会被跳过
- 规则优先级从高到低匹配，第一个匹配的规则生效
- 建议为生产环境快照设置 `protection_level = critical` 以防止意外删除

### 性能考量

- 规则评估目标延迟：< 100ms
- GIN 索引支持高效的标签和 JSONB 查询
- 规则按优先级排序，减少不必要的评估
- Prometheus 指标采集为非阻塞操作
- 并发索引创建（CONCURRENTLY）避免锁表

### 故障排查

常见问题及解决方案：

1. **规则未生效**
   - 检查 `is_active = true`
   - 检查 `target_type` 是否匹配
   - 检查规则优先级顺序

2. **标签查询慢**
   - 验证 GIN 索引是否创建成功：`\d+ snapshots`
   - 检查查询是否使用索引：`EXPLAIN ANALYZE SELECT ...`

3. **Grafana 面板无数据**
   - 确认 Prometheus 正在抓取 `/metrics` 端点
   - 检查指标名称是否正确
   - 验证时间范围设置

4. **迁移失败**
   - 检查数据库连接配置
   - 查看迁移日志中的具体错误
   - 验证是否有足够的数据库权限（CREATE INDEX CONCURRENTLY 需要特殊权限）

### 技术细节

#### 规则评估流程

```
1. 接收操作请求（带有 entityType, entityId, operation, properties）
   ↓
2. SafetyGuard.assessRisk() 调用
   ↓
3. ProtectionRuleService.evaluateRules()
   - 获取目标类型的所有活跃规则（按优先级排序）
   - 逐个评估条件（evaluateConditions）
   - 第一个匹配的规则应用效果
   ↓
4. 应用效果
   - block: 设置 context.details.ruleBlocked = true
   - elevate_risk: 提升 riskLevel
   - require_approval: 启用双重确认
   ↓
5. 记录执行日志到 rule_execution_log
   ↓
6. 返回风险评估结果
```

#### 数据库架构

```sql
-- 快照表扩展
ALTER TABLE snapshots ADD COLUMN tags TEXT[] DEFAULT '{}';
ALTER TABLE snapshots ADD COLUMN protection_level TEXT DEFAULT 'normal';
ALTER TABLE snapshots ADD COLUMN release_channel TEXT;

-- GIN 索引（高效数组/JSONB 查询）
CREATE INDEX idx_snapshots_tags ON snapshots USING GIN(tags);
CREATE INDEX idx_protection_rules_conditions ON protection_rules USING GIN(conditions);

-- 约束确保数据完整性
ALTER TABLE snapshots ADD CONSTRAINT chk_protection_level
  CHECK (protection_level IN ('normal', 'protected', 'critical'));
```

### 相关资源

- **OpenAPI 规范**: `openapi/admin-api.yaml` (已更新，包含 9 个新端点)
- **集成测试**: `tests/integration/snapshot-protection.test.ts` (25 个测试用例)
- **服务实现**:
  - `src/services/ProtectionRuleService.ts` (~600 行)
  - `src/services/SnapshotService.ts` (扩展 +260 行)
- **API 路由**:
  - `src/routes/snapshot-labels.ts`
  - `src/routes/protection-rules.ts`
- **安全防护集成**: `src/guards/SafetyGuard.ts` (async 集成)

---

**实施日期**: 2025-11-19
**版本**: Sprint 2
**状态**: ✅ 完成并准备部署
