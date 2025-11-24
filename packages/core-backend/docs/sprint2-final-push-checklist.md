# Sprint 2: 最终推进步骤清单

> **目标**: 从 Draft PR → 审查 → 合并 → 上线监控的完整流程

---

## 📋 推进步骤（8 步）

### ✅ Step 1: 分配负责人

**任务**: 在审查模板中填充所有负责人字段

**需要分配的角色**：
- [ ] 数据库/迁移审查负责人: ___________
- [ ] 规则引擎审查负责人: ___________
- [ ] SafetyGuard 集成审查负责人: ___________
- [ ] API 安全审查负责人: ___________
- [ ] 可观测性审查负责人: ___________
- [ ] 测试审查负责人: ___________
- [ ] 文档审查负责人: ___________

**建议分工**：
- **数据库专家**（1 人）: 模块 1
- **后端工程师**（1-2 人）: 模块 2、3
- **API/安全工程师**（1 人）: 模块 4
- **SRE/可观测性专家**（1 人）: 模块 5
- **QA 工程师**（1 人）: 模块 6、7

**执行方式**：
```markdown
# 在 PR #2 评论区分配
@db-expert 请审查模块 1（数据库与迁移）
@backend-engineer 请审查模块 2、3（规则引擎 + SafetyGuard）
@security-engineer 请审查模块 4（API 安全）
@sre-engineer 请审查模块 5（可观测性）
@qa-engineer 请审查模块 6、7（测试 + 文档）
```

**完成标志**: 所有负责人已确认并开始审查

---

### ✅ Step 2: 运行 Staging 验证脚本

**任务**: 部署到 staging 并运行验证脚本

**前置条件**：
- [ ] Staging 环境可用
- [ ] 数据库迁移已在 staging 执行
- [ ] 服务已启动
- [ ] 获取 staging API token

**执行命令**：
```bash
# 1. 部署到 staging
git checkout feature/sprint2-snapshot-protection
# ... 部署步骤（根据您的 CD 流程）

# 2. 运行验证脚本
cd packages/core-backend
./scripts/verify-sprint2-staging.sh {STAGING_API_TOKEN} | tee staging-verification-$(date +%Y%m%d).log

# 3. 保存日志
# 日志文件: staging-verification-{date}.log
```

**收集证据**：
- [ ] 验证脚本输出日志（完整）
- [ ] 成功/失败统计
- [ ] 性能基线数据（规则评估延迟）
- [ ] 异常或警告信息

**上传到 PR**：
```bash
# 方式 1: 上传日志文件到 PR
gh pr comment 2 --body "## ✅ Staging 验证结果

验证脚本已执行，详见附件日志。

**摘要**:
- ✅ Database migration: PASSED
- ✅ API endpoints: 9/9 PASSED
- ✅ Performance baseline: avg 45ms (target <100ms)

[完整日志](./staging-verification-{date}.log)" \
  --attachment staging-verification-*.log

# 方式 2: 粘贴关键输出
gh pr comment 2 --body-file staging-verification-summary.md
```

**完成标志**: 验证日志已上传到 PR，关键指标达标

---

### ✅ Step 3: 执行 PromQL 验证

**任务**: 使用模板中的 PromQL 片段验证指标

**执行位置**: Prometheus UI 或 Grafana Explore

**验证查询**（复制自审查模板）：

1. **规则评估速率**
   ```promql
   rate(metasheet_protection_rule_evaluations_total[5m])
   ```

2. **规则阻止操作速率**
   ```promql
   rate(metasheet_protection_rule_blocks_total[5m])
   ```

3. **规则评估延迟 P50/P95**
   ```promql
   histogram_quantile(0.50, rate(metasheet_rule_evaluation_duration_bucket[5m]))
   histogram_quantile(0.95, rate(metasheet_rule_evaluation_duration_bucket[5m]))
   ```

4. **保护级别分布**
   ```promql
   metasheet_snapshot_protection_level
   ```

5. **Top 5 最常用标签**
   ```promql
   topk(5, metasheet_snapshot_tags_total)
   ```

6. **保护快照清理跳过率**
   ```promql
   rate(metasheet_snapshot_protected_skipped_total[5m]) / rate(metasheet_snapshot_cleanup_total[5m])
   ```

**收集结果**：
```markdown
## 📊 PromQL 验证结果

### 指标可抓取性
- ✅ metasheet_snapshot_tags_total
- ✅ metasheet_snapshot_protection_level
- ✅ metasheet_snapshot_release_channel
- ✅ metasheet_protection_rule_evaluations_total
- ✅ metasheet_protection_rule_blocks_total
- ✅ metasheet_snapshot_protected_skipped_total

### 指标值（非零验证）
- 规则评估速率: 2.5/min
- 规则阻止速率: 0.3/min
- P50 延迟: 25ms
- P95 延迟: 78ms
- 保护级别: normal=45, protected=12, critical=3
- Top 5 标签: production=30, staging=15, canary=8, beta=5, experimental=2

### 截图
[上传 Prometheus 查询结果截图]
```

**粘贴到 PR**：
```bash
gh pr comment 2 --body-file promql-verification-results.md
```

**完成标志**: PromQL 验证结果已粘贴到 PR 审查模板

---

### ✅ Step 4: 勾选审查清单 Blocker 项

**任务**: 所有审查员完成 Blocker 级别检查

**Blocker 级别检查项**（必须全部通过）：

#### 数据库与迁移
- [ ] GIN 索引创建策略合理（CONCURRENTLY）
- [ ] CHECK 约束正确
- [ ] Rollback 脚本存在且可执行
- [ ] 大表迁移时长可接受

#### 规则引擎
- [ ] 条件匹配逻辑正确
- [ ] 优先级路由正确
- [ ] 错误处理完整
- [ ] 审计日志完整

#### SafetyGuard 集成
- [ ] Async 转换正确
- [ ] Risk level 映射正确
- [ ] 向后兼容性保证

#### API 安全
- [ ] Bearer token 认证已启用
- [ ] 输入验证完整
- [ ] 审计日志记录

#### 可观测性
- [ ] 指标 cardinality 可控
- [ ] Grafana 面板配置正确
- [ ] PromQL 查询正确

**处理未通过项**：
```markdown
## 🔴 Blocker 问题

### 问题 1: [描述]
- **模块**: 数据库与迁移
- **严重性**: Blocker
- **影响**: [影响说明]
- **修复方案**: [方案]
- **预计修复时间**: X 天
- **负责人**: @developer

### 标记状态
- [ ] REQUEST CHANGES（有 blocker）
- [ ] APPROVED（无 blocker）
```

**完成标志**:
- 无 blocker → 继续 Step 5
- 有 blocker → 修复后重新审查

---

### ✅ Step 5: 标记 Ready for Review

**任务**: 将 PR 从 Draft 改为 Ready for Review

**前置条件**：
- [ ] Staging 验证通过
- [ ] PromQL 验证通过
- [ ] 无 blocker 级别问题
- [ ] 至少 1 名审查员已完成审查

**执行命令**：
```bash
gh pr ready 2
```

或在 GitHub UI 中点击 "Ready for review" 按钮

**通知审查员**：
```bash
gh pr comment 2 --body "## 🚀 PR 已准备好审查

**验证状态**:
- ✅ Staging 验证通过
- ✅ PromQL 指标验证通过
- ✅ 无 blocker 级别问题

**审查状态**:
- ✅ 模块 1-7 已完成初审
- ⏳ 等待最终批准

**需要**: 至少 2 名审查员批准（DB + 后端）

请 @reviewers 进行最终审查和批准。"
```

**完成标志**: PR 状态改为 "Ready for review"

---

### ✅ Step 6: 收集审核人批准

**任务**: 获得至少 2 名审核人的 APPROVED

**建议审核人组合**：
- **必须**: DB 专家（数据库迁移审查）
- **必须**: 后端工程师（规则引擎 + SafetyGuard）
- **可选**: SRE（可观测性）或安全工程师（API 安全）

**批准流程**：
1. 审核人使用审查模板进行审查
2. 填写 "审批结论" 部分
3. 选择 "✅ APPROVED"
4. 在 GitHub 提交 "Approve" review

**GitHub 批准命令**（审核人执行）：
```bash
# 审核人 1（DB 专家）
gh pr review 2 --approve --body "✅ 数据库迁移审查通过

- GIN 索引策略合理
- 回滚脚本已验证
- 性能影响可接受"

# 审核人 2（后端工程师）
gh pr review 2 --approve --body "✅ 规则引擎和 SafetyGuard 集成审查通过

- 规则匹配逻辑正确
- 异步集成无问题
- 测试覆盖充分"
```

**监控状态**：
```bash
gh pr view 2 --json reviews
```

**完成标志**: ≥ 2 个 APPROVED reviews

---

### ✅ Step 7: Squash 合并

**任务**: 执行 Squash Merge 并更新 CHANGELOG

#### 7.1 更新 CHANGELOG 版本号

**编辑文件**: `packages/core-backend/CHANGELOG.md`

```markdown
# 改前
## [Unreleased]

### Added - Sprint 2: Snapshot Protection System (2025-11-19)
...

# 改后
## [2.1.0] - 2025-11-19

### Added - Sprint 2: Snapshot Protection System
...
```

**提交更新**：
```bash
git add CHANGELOG.md
git commit -m "chore: prepare CHANGELOG for v2.1.0 release"
git push
```

#### 7.2 执行 Squash Merge

**使用预定义的 commit 消息**（见 `docs/sprint2-squash-commit-message.md`）

**GitHub UI 方式**：
1. 点击 "Squash and merge"
2. 复制 squash commit 消息模板
3. 粘贴并提交

**命令行方式**：
```bash
gh pr merge 2 --squash --body-file docs/sprint2-squash-commit-message.md
```

**完成标志**: PR 已合并到 main，commit 出现在 main 分支

---

### ✅ Step 8: 合并后监控

**任务**: 执行合并后 24 小时监控计划

**监控责任人**（从审查模板获取）：
- **生产部署监控负责人**: ___________
- **异常响应联系人**: ___________
- **回滚决策人**: ___________

**监控时间窗口**: 合并后 3-24 小时

#### 监控项目

**1. 规则评估性能**（前 3 小时密集监控）
```promql
# P95 延迟应 < 100ms
histogram_quantile(0.95, rate(metasheet_rule_evaluation_duration_bucket[5m]))

# 告警阈值: P95 > 150ms
```

**2. 规则阻止率**（前 3 小时）
```promql
# 阻止率应在预期范围内（如 < 5%）
rate(metasheet_protection_rule_blocks_total[5m])
/
rate(metasheet_protection_rule_evaluations_total[5m])

# 告警阈值: > 10%（异常高阻止率）
```

**3. 错误日志监控**（持续 24 小时）
```bash
# 检查 SafetyGuard 和 ProtectionRuleService 错误
grep -i "error\|exception" /var/log/metasheet/app.log | grep -E "(SafetyGuard|ProtectionRule)"
```

**4. 数据库性能**（前 6 小时）
```sql
-- 检查 GIN 索引使用情况
SELECT schemaname, tablename, indexname, idx_scan
FROM pg_stat_user_indexes
WHERE indexname LIKE 'idx_snapshots_%'
OR indexname LIKE 'idx_protection_rules_%';

-- 慢查询监控（> 1s）
SELECT query, mean_exec_time
FROM pg_stat_statements
WHERE mean_exec_time > 1000
AND query LIKE '%snapshots%' OR query LIKE '%protection_rules%';
```

**5. 功能验证**（部署后 1 小时内）
```bash
# 快速功能验证
./scripts/verify-sprint2-staging.sh {PRODUCTION_API_TOKEN}
```

#### 监控检查点

**T+1h** (部署后 1 小时):
- [ ] 功能验证脚本通过
- [ ] 规则评估 P95 < 100ms
- [ ] 无异常错误日志

**T+3h** (部署后 3 小时):
- [ ] 规则阻止率正常（< 5%）
- [ ] 数据库查询性能正常
- [ ] Grafana 仪表板数据正常

**T+24h** (部署后 24 小时):
- [ ] 无性能退化
- [ ] 无异常告警
- [ ] 用户反馈正常

#### 回滚准备

**回滚触发条件**（任一满足立即回滚）：
- [ ] 规则评估 P95 > 200ms 持续 > 10 分钟
- [ ] 错误率 > 1% 持续 > 5 分钟
- [ ] 数据库死锁或严重性能问题
- [ ] 关键功能不可用

**回滚执行**：
```bash
# 1. 停止服务
systemctl stop metasheet

# 2. 回滚数据库迁移
cd packages/core-backend
npm run migrate:down  # 回滚 2 个迁移

# 3. 切换代码到 main@前一个版本
git checkout main~1

# 4. 重启服务
systemctl start metasheet

# 5. 验证回滚成功
./scripts/verify-production-health.sh
```

**回滚决策人**: ___________ （必须授权才能执行）

**完成标志**:
- 监控 24 小时无异常 → Sprint 2 上线成功 ✅
- 或回滚成功 → 问题分析 → 修复 → 重新上线

---

## 🔧 可选额外加固

### 选项 1: ProtectionRuleService 单元测试 CI Gate

**目的**: 防止未来改动破坏规则评估逻辑

**实施步骤**：
1. 创建单元测试文件: `tests/unit/ProtectionRuleService.test.ts`
2. 添加 CI 配置:
   ```yaml
   # .github/workflows/protection-rule-tests.yml
   name: Protection Rule Tests
   on: [pull_request]
   jobs:
     test:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v3
         - run: npm install
         - run: npm test -- tests/unit/ProtectionRuleService.test.ts
   ```
3. 设置为 required check

**成本**: ~2 小时实施

---

### 选项 2: 规则匹配性能基线脚本

**目的**: 建立性能基线，监控未来性能退化

**脚本**: `scripts/benchmark-rule-evaluation.ts`

```typescript
// 评估 1000 规则内平均耗时
import { protectionRuleService } from '../src/services/ProtectionRuleService'

async function benchmark() {
  const results = []
  for (let i = 0; i < 1000; i++) {
    const start = Date.now()
    await protectionRuleService.evaluateRules({
      entity_type: 'snapshot',
      entity_id: 'test-snapshot',
      operation: 'delete',
      properties: { tags: ['production'], protection_level: 'normal' }
    })
    results.push(Date.now() - start)
  }

  console.log(`P50: ${percentile(results, 0.50)}ms`)
  console.log(`P95: ${percentile(results, 0.95)}ms`)
  console.log(`P99: ${percentile(results, 0.99)}ms`)
}

benchmark()
```

**执行并存档**：
```bash
npx tsx scripts/benchmark-rule-evaluation.ts | tee benchmark-$(date +%Y%m%d).txt
```

**成本**: ~1 小时实施

---

### 选项 3: Staging 验证结果收集模板

**已创建**: `docs/sprint2-staging-verification-results-template.md`

（见下个文件）

---

### 选项 4: Squash Commit 最终消息

**已创建**: `docs/sprint2-squash-commit-message.md`

（见下个文件）

---

## 📊 进度追踪

| 步骤 | 负责人 | 预计时间 | 状态 | 完成时间 |
|------|--------|----------|------|----------|
| 1. 分配负责人 | PM | 10 分钟 | ⏳ | |
| 2. Staging 验证 | SRE | 30 分钟 | ⏳ | |
| 3. PromQL 验证 | SRE | 20 分钟 | ⏳ | |
| 4. 审查 Blocker | 各审查员 | 2-3 小时 | ⏳ | |
| 5. Ready for Review | PM | 5 分钟 | ⏳ | |
| 6. 收集批准 | 审核人 | 1-2 天 | ⏳ | |
| 7. Squash 合并 | PM | 10 分钟 | ⏳ | |
| 8. 合并后监控 | SRE | 24 小时 | ⏳ | |

**预计总时长**: 2-3 天（包括审查时间）

---

**文档版本**: 1.0
**创建日期**: 2025-11-19
**PR**: #2
