# ViewService统一回滚预案

**创建日期**: 2025-09-30
**负责人**: [后端负责人]
**风险等级**: 🟡 中等（核心服务变更）

---

## 回滚触发条件

以下任一情况发生时，应立即执行回滚：

1. **功能性错误**
   - ❌ 五类视图中任意一种无法正常渲染
   - ❌ RBAC权限检查失败（应返回403但返回200，或相反）
   - ❌ 用户状态持久化失败（view_states表写入错误）

2. **性能问题**
   - ❌ P99延迟增长 >20%（相比baseline）
   - ❌ QPS下降 >15%
   - ❌ 内存泄漏（24小时内增长 >10%）

3. **数据安全**
   - ❌ 数据丢失或损坏
   - ❌ 权限绕过漏洞
   - ❌ 大量5xx错误（错误率 >1%）

4. **用户反馈**
   - ❌ 生产环境严重Bug报告 ≥3个
   - ❌ 关键客户投诉

---

## 快速回滚步骤

### 阶段1: 紧急降级（5分钟内）

```bash
# 1. SSH到生产服务器
ssh prod-backend-01

# 2. 关闭ViewService V2特性开关
sudo tee -a /etc/metasheet/env.d/features.conf <<EOF
export USE_VIEW_SERVICE_V2=false
EOF

# 3. 重启后端服务（优雅重启，避免连接中断）
sudo systemctl reload metasheet-backend

# 4. 验证降级成功
curl -s http://localhost:8900/api/admin/config | jq '.features.VIEW_SERVICE_V2'
# 应返回: false

# 5. 检查服务健康
curl -s http://localhost:8900/health | jq '.status'
# 应返回: "ok"
```

**预期结果**: 系统回退到旧ViewService，功能恢复正常

**验证检查清单**:
- [ ] 特性开关已关闭 (`USE_VIEW_SERVICE_V2=false`)
- [ ] 服务健康检查通过 (`/health` 返回200)
- [ ] 用户可以正常访问视图 (抽样测试5个视图)
- [ ] 错误率降至正常水平 (<0.1%)

---

### 阶段2: 代码回滚（30分钟内）

如果特性开关降级无效（说明旧ViewService也被破坏），需要回滚代码：

```bash
# 1. 获取合并前的commit hash
git log --oneline --grep="ViewService统一" -1
# 假设输出: abc1234 feat: unify ViewService (#PR_NUM)

# 2. 创建回滚分支
git checkout -b revert/viewservice-unification main

# 3. 回滚代码
git revert abc1234 --no-commit

# 4. 解决冲突（如果有）
# 手动编辑冲突文件
git add .
git revert --continue

# 5. 推送回滚分支
git push origin revert/viewservice-unification

# 6. 创建紧急PR
gh pr create \
  --base main \
  --head revert/viewservice-unification \
  --title "revert: ViewService unification (rollback due to production issue)" \
  --body "## 回滚原因
[填写具体原因]

## 影响范围
- ViewService功能恢复到合并前状态
- 数据库Schema保持不变

## 验证
- [ ] 本地测试通过
- [ ] staging环境验证通过

## 风险
低 - 回退到已知稳定状态

cc @backend-lead @platform-team" \
  --label "priority:critical,revert"

# 7. 快速审核并合并
# （紧急情况下可绕过常规审核流程）
gh pr merge --squash --auto
```

**预期结果**: 代码回退到合并前状态

---

### 阶段3: 数据库回滚（如需要，1小时内）

如果合并包含数据库迁移（如`045_view_query_indexes.sql`），需要回滚数据库：

```bash
# 1. 备份当前数据库（必须！）
pg_dump -h prod-db-01 -U metasheet -d metasheet_v2 \
  --format=custom \
  --file=/backup/metasheet_v2_pre_rollback_$(date +%Y%m%d_%H%M%S).dump

# 2. 检查迁移历史
psql -h prod-db-01 -U metasheet -d metasheet_v2 \
  -c "SELECT * FROM schema_migrations ORDER BY version DESC LIMIT 5;"

# 3. 回滚迁移（假设045是最新的）
cd packages/core-backend
pnpm db:rollback  # 回滚一个版本

# 4. 验证回滚
psql -h prod-db-01 -U metasheet -d metasheet_v2 \
  -c "SELECT * FROM schema_migrations ORDER BY version DESC LIMIT 5;"
# 确认045不在列表中

# 5. 验证索引已删除
psql -h prod-db-01 -U metasheet -d metasheet_v2 \
  -c "SELECT indexname FROM pg_indexes WHERE tablename = 'views';"
# 确认045创建的索引已删除
```

**⚠️ 警告**: 数据库回滚有风险，必须先备份！

**数据完整性检查**:
```sql
-- 检查views表数据完整性
SELECT COUNT(*) FROM views;
SELECT COUNT(DISTINCT id) FROM views;
-- 两者应相等

-- 检查view_states表数据完整性
SELECT COUNT(*) FROM view_states;
SELECT COUNT(*) FROM view_states WHERE state IS NULL;
-- 后者应为0
```

---

## 回滚后验证

### 功能验证清单

```bash
# 1. 五类视图功能测试
curl -X POST http://localhost:8900/api/views \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "tableId": "test-table",
    "type": "grid",
    "name": "Test Grid"
  }'

# 重复上述测试，type分别为: kanban, gallery, form, calendar
# 所有类型都应成功创建

# 2. RBAC权限测试
# 2.1 未授权访问（应返回403）
curl -X GET http://localhost:8900/api/views/test-view-id \
  -H "Authorization: Bearer $UNPRIVILEGED_TOKEN"
# 应返回: 403 Forbidden

# 2.2 授权访问（应返回200）
curl -X GET http://localhost:8900/api/views/test-view-id \
  -H "Authorization: Bearer $PRIVILEGED_TOKEN"
# 应返回: 200 OK

# 3. 用户状态持久化测试
curl -X POST http://localhost:8900/api/kanban/test-view-id/state \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "state": {
      "columns": [
        {"id": "todo", "order": 1, "cards": ["card1"]}
      ]
    }
  }'
# 应返回: 204 No Content

# 4. 性能基准测试
ab -n 1000 -c 10 -H "Authorization: Bearer $TOKEN" \
  http://localhost:8900/api/views/test-view-id
# 记录P50/P95/P99延迟，与baseline对比
```

### 监控指标验证

```bash
# 1. 错误率应恢复正常
curl -s http://localhost:9090/api/v1/query?query='rate(http_requests_total{status=~"5.."}[5m])' | jq '.data.result[0].value[1]'
# 应 <0.001 (0.1%)

# 2. 延迟应恢复正常
curl -s http://localhost:9090/api/v1/query?query='histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m]))' | jq '.data.result[0].value[1]'
# 应 <0.5 (500ms)

# 3. 内存使用稳定
curl -s http://localhost:9090/api/v1/query?query='process_resident_memory_bytes' | jq '.data.result[0].value[1]'
# 记录并监控，1小时内增长应 <1%
```

---

## 根因分析（回滚后执行）

### 数据收集

```bash
# 1. 收集错误日志
journalctl -u metasheet-backend --since "1 hour ago" --no-pager > /tmp/rollback-error-logs.txt

# 2. 收集Prometheus指标
curl -s http://localhost:9090/api/v1/query_range \
  --data-urlencode 'query=http_requests_total{status=~"5.."}' \
  --data-urlencode 'start='$(date -u -d '1 hour ago' +%s) \
  --data-urlencode 'end='$(date -u +%s) \
  --data-urlencode 'step=60' \
  > /tmp/rollback-metrics.json

# 3. 收集数据库慢查询
psql -h prod-db-01 -U metasheet -d metasheet_v2 \
  -c "SELECT * FROM pg_stat_statements ORDER BY mean_exec_time DESC LIMIT 20;" \
  > /tmp/rollback-slow-queries.txt

# 4. 收集Git diff
git diff main..revert/viewservice-unification > /tmp/rollback-code-diff.txt
```

### 分析报告模板

```markdown
# ViewService回滚根因分析报告

**回滚日期**: [填写]
**回滚负责人**: [填写]
**影响时长**: [填写]
**影响用户数**: [填写]

## 问题描述
[详细描述触发回滚的问题]

## 根本原因
[分析问题根源]

## 时间线
- [时间1]: 合并PR
- [时间2]: 部署到生产
- [时间3]: 发现问题
- [时间4]: 开始回滚
- [时间5]: 回滚完成
- [时间6]: 验证恢复

## 数据分析
- 错误率: [峰值] → [回滚后]
- 延迟: [P99峰值] → [回滚后]
- 影响请求数: [总数]
- 影响用户数: [去重后]

## 预防措施
[如何避免类似问题再次发生]

## Action Items
- [ ] [具体改进措施1]
- [ ] [具体改进措施2]
- [ ] [更新测试用例]
- [ ] [更新部署流程]

## 附件
- 错误日志: /tmp/rollback-error-logs.txt
- 监控指标: /tmp/rollback-metrics.json
- 慢查询: /tmp/rollback-slow-queries.txt
- 代码diff: /tmp/rollback-code-diff.txt
```

---

## 回滚后恢复计划

### 重新尝试合并（修复问题后）

```bash
# 1. 创建修复分支
git checkout -b fix/viewservice-unification-v2 main

# 2. Cherry-pick原始变更
git cherry-pick abc1234  # ViewService统一的原始commit

# 3. 应用修复
# [根据根因分析，应用具体修复代码]

# 4. 增强测试
# 添加针对回滚问题的测试用例

# 5. staging环境验证
# 部署到staging，运行完整测试套件

# 6. 小流量灰度
# 1% → 10% → 50% → 100%

# 7. 监控并准备快速回滚
# 保持24小时监控，有问题立即回滚
```

---

## 联系人

**紧急联系人**:
- 后端负责人: [姓名] [手机] [邮箱]
- 架构师: [姓名] [手机] [邮箱]
- DBA: [姓名] [手机] [邮箱]
- On-Call: [当前值班人员]

**Slack频道**: #incident-response

**Incident Tracking**: [Jira/GitHub Issue链接]

---

## 回滚演练

**建议频率**: 每季度一次

**演练步骤**:
1. 在staging环境模拟ViewService故障
2. 执行上述回滚步骤
3. 测量回滚时间（目标: <10分钟完成阶段1）
4. 记录问题和改进点
5. 更新此文档

**上次演练**: [日期]
**下次演练**: [日期]

---

**最后更新**: 2025-09-30
**版本**: 1.0
