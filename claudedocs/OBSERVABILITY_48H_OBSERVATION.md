# 48小时观察期计划
**Approvals Contract Tests 双处集成观察**

## 📅 观察期时间表

### 起始时间
- **合并时间**: 2025-11-06 06:23 UTC (14:23 Beijing)
- **commit**: 4b01764b (PR #392)
- **当前时间**: 2025-11-06 06:28 UTC

### 结束时间
- **观察期结束**: 2025-11-08 06:28 UTC (14:28 Beijing)
- **总计**: 48小时

### 关键时间点

#### 第一次 Nightly 运行
- **时间**: 2025-11-07 02:00 UTC (10:00 AM Beijing)
- **距离**: ~19.5小时
- **重要性**: 🔴 首次验证双处集成的 approvals-contract job

#### 第二次 Nightly 运行
- **时间**: 2025-11-08 02:00 UTC (10:00 AM Beijing)
- **距离**: ~43.5小时
- **重要性**: 🔴 观察期内最后一次验证，确认稳定性

#### 第三次 Nightly 运行
- **时间**: 2025-11-09 02:00 UTC (10:00 AM Beijing)
- **距离**: ~67.5小时 (观察期后)
- **重要性**: 🟡 可选的额外验证点

## 📊 监控清单

### 1. Nightly Main Branch Verification 运行

#### 手动模拟 Nightly（提前信号） — 2025-11-06

- Observability — success — 4m48s — https://github.com/zensgit/smartsheet/actions/runs/19128931425
- Migration Replay — success — 1m25s — https://github.com/zensgit/smartsheet/actions/runs/19128932089
- Observability (V2 Strict) — success — 2m26s — https://github.com/zensgit/smartsheet/actions/runs/19128941584
- Approvals Contract Tests — success — 1m17s — https://github.com/zensgit/smartsheet/actions/runs/19128942349

#### 监控指标
```bash
# 查看 nightly 运行历史
gh run list --workflow=nightly-main-verification.yml --event=schedule --limit 5

# 查看特定运行详情
gh run view <run-id> --json conclusion,jobs

# 检查 approvals-contract job
gh run view <run-id> --json jobs --jq '.jobs[] | select(.name == "Approvals Contract Tests (Main)") | {name, conclusion, steps: [.steps[] | {name, conclusion}]}'
```

#### 成功标准
- [ ] 2025-11-07 02:00 UTC 运行: ✅ approvals-contract job 通过
- [ ] 2025-11-08 02:00 UTC 运行: ✅ approvals-contract job 通过
- [ ] 两次运行时间稳定 (1m15s ~ 1m30s 范围内)
- [ ] 无 flaky 测试或随机失败

#### 失败场景处理
```bash
# 如果 approvals-contract job 失败
gh run view <run-id> --log | grep -A 50 "Approvals Contract Tests (Main)"

# 下载失败时的服务器日志
gh run download <run-id> --name approvals-contract-server-log

# 创建 issue 跟踪
gh issue create \
  --title "Nightly: Approvals Contract Tests failed - $(date +%Y-%m-%d)" \
  --label "ci,observability,bug,nightly" \
  --body "观察期发现 approvals-contract job 失败..."
```

### 2. PR 检查中的合约测试

#### 监控指标
```bash
# 查看最近的 PR 运行 (observability-strict)
gh run list --workflow=observability-strict.yml --branch=main --limit 5

# 查看特定步骤日志
gh run view <run-id> --log | grep -A 50 "Run approvals contract tests (comprehensive)"
```

#### 成功标准
- [ ] 至少 3 个新 PR 触发 observability-strict 工作流
- [ ] "Run approvals contract tests" 步骤在所有 PR 中通过
- [ ] 测试输出与 nightly 运行一致 (11个测试全部通过)
- [ ] 运行时间稳定 (~1m20s)

#### 验证命令
```bash
# 检查最近 5 个 PR 的 observability-strict 运行
gh run list --workflow=observability-strict.yml --limit 5 \
  --json databaseId,conclusion,createdAt,displayTitle

# 对每个运行检查合约测试步骤
for run_id in $(gh run list --workflow=observability-strict.yml --limit 5 --json databaseId --jq '.[].databaseId'); do
  echo "=== Run $run_id ==="
  gh run view $run_id --log | grep -E "🧪 Starting Approvals API Contract Tests|Tests Passed|Tests Failed" | head -3
done
```

### 3. 一致性验证

#### 验证点
- [ ] PR 和 Nightly 运行的测试输出格式一致
- [ ] 两处均执行 11 个测试用例
- [ ] 失败场景在两处均能正确检测
- [ ] 数据库配置一致 (PostgreSQL 15)

#### 一致性检查脚本
```bash
#!/bin/bash
# 比较 PR 和 Nightly 的测试输出

echo "=== 获取最近的 PR 运行 ==="
PR_RUN=$(gh run list --workflow=observability-strict.yml --limit 1 --json databaseId --jq '.[0].databaseId')
echo "PR Run ID: $PR_RUN"

echo "=== 获取最近的 Nightly 运行 ==="
NIGHTLY_RUN=$(gh run list --workflow=nightly-main-verification.yml --event=schedule --limit 1 --json databaseId --jq '.[0].databaseId')
echo "Nightly Run ID: $NIGHTLY_RUN"

echo "=== PR 测试输出 ==="
gh run view $PR_RUN --log | grep -E "🧪|✅|❌|Tests Passed|Tests Failed" | grep -v "grep"

echo "=== Nightly 测试输出 ==="
gh run view $NIGHTLY_RUN --log | grep -E "🧪|✅|❌|Tests Passed|Tests Failed" | grep -v "grep"
```

### 4. 性能监控

#### 基准指标 (基于首次成功运行)
```yaml
approvals_contract_tests:
  total_time: "1m15s ~ 1m30s"
  breakdown:
    database_startup: "~30s"
    backend_health_check: "~30s"
    test_execution: "~15s"

  acceptable_variance: "±20%"
  warning_threshold: ">1m50s"
  critical_threshold: ">2m30s"
```

#### 性能检查命令
```bash
# 查看最近 10 次运行的时间
gh run list --workflow=approvals-contract.yml --limit 10 \
  --json databaseId,conclusion,createdAt,updatedAt \
  | jq '.[] | {
      id: .databaseId,
      conclusion: .conclusion,
      duration_sec: (((.updatedAt | fromdateiso8601) - (.createdAt | fromdateiso8601)))
    }'

# 计算平均运行时间
gh run list --workflow=approvals-contract.yml --limit 10 --json createdAt,updatedAt \
  | jq '[.[] | (((.updatedAt | fromdateiso8601) - (.createdAt | fromdateiso8601)))] | add / length'
```

#### 性能异常处理
```yaml
scenario_1_slow_execution:
  condition: "运行时间 > 1m50s"
  action:
    - "检查数据库启动日志"
    - "检查后端健康检查时间"
    - "验证测试执行时间"
    - "比较历史运行确认趋势"

scenario_2_timeout:
  condition: "运行超时 (>10分钟)"
  action:
    - "检查 PostgreSQL 健康检查失败"
    - "检查后端启动失败"
    - "查看上传的服务器日志"
    - "创建 bug issue 跟踪"

scenario_3_progressive_slowdown:
  condition: "运行时间持续增加"
  action:
    - "检查是否有资源泄漏"
    - "验证数据库清理是否正常"
    - "检查测试数据积累"
```

### 5. 错误恢复能力

#### 测试场景
```yaml
test_database_failure:
  trigger: "手动停止 PostgreSQL 服务"
  expected: "Job 失败，清晰错误信息"
  validation: "检查日志包含 'pg_isready' 失败信息"

test_backend_startup_failure:
  trigger: "DATABASE_URL 配置错误"
  expected: "后端健康检查超时，Job 失败"
  validation: "检查服务器日志上传成功"

test_contract_violation:
  trigger: "修改 API 返回状态码"
  expected: "合约测试失败，具体指出哪个测试"
  validation: "失败信息包含测试名称和期望/实际值"
```

#### 错误恢复验证命令
```bash
# 查看失败的运行
gh run list --workflow=approvals-contract.yml --status failure --limit 5

# 检查失败详情
gh run view <failed-run-id> --json jobs --jq '.jobs[] | select(.conclusion == "failure") | {name, steps: [.steps[] | select(.conclusion == "failure") | .name]}'

# 验证服务器日志是否上传
gh run view <failed-run-id> --log | grep "Upload server log"
```

## 📋 日常检查清单

### 每日检查 (观察期内)
- [ ] **早上 10:00 AM Beijing (2:00 UTC)**: 检查 nightly 运行结果
- [ ] **下午检查**: 查看是否有新 PR 触发 observability-strict
- [ ] **晚上总结**: 记录当天发现的任何异常

### 检查脚本
```bash
#!/bin/bash
# daily-check.sh - 每日观察期检查脚本

echo "=== 📅 日期: $(date +%Y-%m-%d) ==="
echo ""

echo "=== 🌙 Nightly 运行状态 ==="
gh run list --workflow=nightly-main-verification.yml --event=schedule --limit 1 \
  --json databaseId,conclusion,createdAt,displayTitle \
  | jq -r '.[] | "Run ID: \(.databaseId)\nStatus: \(.conclusion)\nTime: \(.createdAt)\nTitle: \(.displayTitle)\n"'

echo "=== 🔧 PR 检查运行状态 (最近3个) ==="
gh run list --workflow=observability-strict.yml --limit 3 \
  --json databaseId,conclusion,createdAt,displayTitle \
  | jq -r '.[] | "Run ID: \(.databaseId) | Status: \(.conclusion) | Title: \(.displayTitle)"'

echo ""
echo "=== ⏱️  Approvals Contract Tests 运行时间 ==="
gh run list --workflow=approvals-contract.yml --limit 5 \
  --json databaseId,conclusion,createdAt,updatedAt \
  | jq '.[] | {
      id: .databaseId,
      conclusion: .conclusion,
      duration: (((.updatedAt | fromdateiso8601) - (.createdAt | fromdateiso8601)) | tostring + "s")
    }'

echo ""
echo "=== 📊 观察期进度 ==="
START_TIME="2025-11-06T06:28:00Z"
END_TIME="2025-11-08T06:28:00Z"
CURRENT_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

START_EPOCH=$(date -d "$START_TIME" +%s)
END_EPOCH=$(date -d "$END_TIME" +%s)
CURRENT_EPOCH=$(date -d "$CURRENT_TIME" +%s)

ELAPSED=$((CURRENT_EPOCH - START_EPOCH))
TOTAL=$((END_EPOCH - START_EPOCH))
PERCENTAGE=$((ELAPSED * 100 / TOTAL))

echo "开始时间: $START_TIME"
echo "当前时间: $CURRENT_TIME"
echo "结束时间: $END_TIME"
echo "进度: $PERCENTAGE% ($ELAPSED / $TOTAL 秒)"
```

## 🎯 观察期结束决策

### 成功标准 (ALL 必须满足)

#### ✅ 稳定性标准
- [ ] 至少 2 次 nightly 运行成功通过
- [ ] 至少 3 个 PR 运行成功通过
- [ ] 无 flaky 测试 (成功率 100%)
- [ ] 无未预期的失败

#### ✅ 一致性标准
- [ ] PR 和 Nightly 测试结果一致
- [ ] 测试覆盖范围一致 (11个测试)
- [ ] 失败场景检测一致
- [ ] 数据库配置一致

#### ✅ 性能标准
- [ ] 运行时间稳定 (1m15s ~ 1m30s)
- [ ] 无资源泄漏或超时
- [ ] 数据库健康检查成功率 100%
- [ ] 后端启动成功率 100%

#### ✅ 可靠性标准
- [ ] 失败时日志清晰可读
- [ ] 错误恢复机制正常工作
- [ ] 服务器日志上传成功
- [ ] 通知机制正常工作 (如果有失败)

### 观察期成功 → 下一步行动

如果所有成功标准都满足:

```bash
#!/bin/bash
# add-to-required-checks.sh

echo "✅ 观察期成功完成"
echo "📋 准备将 'Approvals Contract Tests' 加入分支保护"

# 1. 获取当前分支保护配置
gh api repos/zensgit/smartsheet/branches/main/protection > /tmp/current_protection.json

echo "当前 required checks:"
jq -r '.required_status_checks.contexts[]' /tmp/current_protection.json

# 2. 添加 "Approvals Contract Tests" 到 required checks
jq '.required_status_checks.contexts += ["Approvals Contract Tests"]' /tmp/current_protection.json > /tmp/updated_protection.json

# 3. 确认更新
echo ""
echo "更新后的 required checks:"
jq -r '.required_status_checks.contexts[]' /tmp/updated_protection.json

# 4. 应用更新 (需要手动确认)
echo ""
read -p "确认更新分支保护? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  gh api -X PUT repos/zensgit/smartsheet/branches/main/protection \
    --input /tmp/updated_protection.json

  echo "✅ 分支保护已更新"
  echo "🎉 Approvals Contract Tests 现在是必需检查"
else
  echo "❌ 取消更新"
fi
```

**完成后验证**:
```bash
# 验证更新成功
gh api repos/zensgit/smartsheet/branches/main/protection \
  | jq -r '.required_status_checks.contexts[]' \
  | grep "Approvals Contract Tests"

# 预期输出: Approvals Contract Tests
```

### 观察期失败 → 问题处理

如果任何成功标准未满足:

#### 1. 问题分类

**类型 A: Flaky 测试**
```yaml
symptoms:
  - 间歇性失败
  - 相同配置下结果不一致
  - 错误信息不明确

actions:
  - 分析失败日志寻找模式
  - 检查测试数据竞争条件
  - 增加等待时间或重试逻辑
  - 隔离 flaky 测试进行修复

resolution_time: "1-3 天"
```

**类型 B: 性能问题**
```yaml
symptoms:
  - 运行时间持续增加
  - 超时或资源耗尽
  - 数据库启动缓慢

actions:
  - 优化数据库配置
  - 减少测试数据量
  - 并行化测试执行
  - 增加资源限制

resolution_time: "2-5 天"
```

**类型 C: 一致性问题**
```yaml
symptoms:
  - PR 和 Nightly 结果不同
  - 测试覆盖范围不一致
  - 配置差异导致失败

actions:
  - 对齐环境配置
  - 统一测试执行方式
  - 确保依赖版本一致
  - 修复工作流差异

resolution_time: "1-2 天"
```

**类型 D: 严重 Bug**
```yaml
symptoms:
  - 持续失败无法恢复
  - 破坏现有功能
  - 阻塞其他工作流

actions:
  - 立即回滚 PR #392 (保留 PR #391)
  - 创建 hotfix 修复问题
  - 重新测试修复
  - 重启 48 小时观察期

resolution_time: "立即回滚, 1-2 周修复"
```

#### 2. 回滚计划

如果需要回滚 PR #392:

```bash
#!/bin/bash
# rollback-pr392.sh

echo "⚠️  准备回滚 PR #392 (保留 PR #391)"

# 1. 创建回滚分支
git checkout main
git pull origin main
git checkout -b revert/pr392-rollback

# 2. 回滚 PR #392 的更改
git revert 4b01764b --no-edit

# 3. 验证回滚
echo "验证回滚内容:"
git diff main..revert/pr392-rollback --stat

# 4. 提交并推送
git push origin revert/pr392-rollback

# 5. 创建回滚 PR
gh pr create \
  --title "revert: rollback PR #392 dual integration due to [问题描述]" \
  --body "## 回滚原因

观察期发现以下问题:
- [问题 1]
- [问题 2]

## 保留内容
- ✅ PR #391: Approvals Contract Tests 基础设施 (test-approvals-contract.mjs)
- ✅ approvals-contract.yml 工作流 (可独立运行)

## 回滚内容
- ❌ nightly-main-verification.yml 的 approvals-contract job
- ❌ observability-strict.yml 的合约测试步骤

## 下一步
修复问题后重新实施双处集成并重启 48 小时观察期。

cc: @maintainers" \
  --label "revert,ci,observability"

echo "✅ 回滚 PR 已创建"
```

#### 3. 问题跟踪

```bash
# 创建 issue 跟踪观察期问题
gh issue create \
  --title "观察期失败: Approvals Contract Tests 双处集成问题" \
  --label "ci,observability,bug,priority-high" \
  --body "## 观察期结果

**时间范围**: 2025-11-06 ~ 2025-11-08
**结果**: ❌ 未通过

## 发现的问题

### 问题 1: [问题标题]
- **现象**: [详细描述]
- **影响**: [严重程度]
- **根本原因**: [分析结果]
- **修复方案**: [建议方案]

### 问题 2: [问题标题]
- **现象**: [详细描述]
- **影响**: [严重程度]
- **根本原因**: [分析结果]
- **修复方案**: [建议方案]

## 决策

- [ ] 回滚 PR #392
- [ ] 修复问题
- [ ] 重新测试
- [ ] 重启 48 小时观察期

## 参考资源
- PR #391: https://github.com/zensgit/smartsheet/pull/391
- PR #392: https://github.com/zensgit/smartsheet/pull/392
- 观察期计划: metasheet-v2/claudedocs/OBSERVABILITY_48H_OBSERVATION.md
- 完成报告: metasheet-v2/claudedocs/PR391_392_COMPLETION_REPORT.md"
```

## 📈 观察期日志模板

### 日志格式
```markdown
## 观察日志 - 2025-11-XX

### 🌙 Nightly 运行
- **Run ID**: [run-id]
- **时间**: [运行时间]
- **结果**: ✅ / ❌
- **持续时间**: [运行时长]
- **Job 4 (approvals-contract)**: ✅ / ❌
- **备注**: [任何异常观察]

### 🔧 PR 检查运行
- **PR #XXX**:
  - Run ID: [run-id]
  - 结果: ✅ / ❌
  - 合约测试: ✅ / ❌
  - 备注: [任何异常]

### 📊 性能指标
- **平均运行时间**: [时间]
- **最慢运行**: [时间] (Run ID: [run-id])
- **最快运行**: [时间] (Run ID: [run-id])
- **趋势**: ↗️ / ➡️ / ↘️

### 🔍 观察发现
- [记录任何异常、警告或需要关注的点]

### ✅ 今日检查清单
- [ ] Nightly 运行检查完成
- [ ] PR 运行检查完成
- [ ] 性能指标记录完成
- [ ] 异常问题已跟踪
```

## 🔗 相关资源

### 文档
- **完成报告**: `metasheet-v2/claudedocs/PR391_392_COMPLETION_REPORT.md`
- **Phase 3 计划**: `metasheet-v2/claudedocs/OBSERVABILITY_PHASE3_PLAN.md`
- **合约测试规范**: `metasheet-v2/claudedocs/APPROVALS_CONTRACT_TESTS.md`

### 工作流文件
- **Approvals Contract**: `.github/workflows/approvals-contract.yml`
- **Nightly Verification**: `.github/workflows/nightly-main-verification.yml`
- **Observability Strict**: `.github/workflows/observability-strict.yml`

### 测试脚本
- **合约测试**: `metasheet-v2/packages/core-backend/scripts/test-approvals-contract.mjs`

### GitHub Resources
- **PR #391**: https://github.com/zensgit/smartsheet/pull/391
- **PR #392**: https://github.com/zensgit/smartsheet/pull/392
- **Actions**: https://github.com/zensgit/smartsheet/actions

---

**观察期状态**: ⏳ 进行中 (2025-11-06 06:28 UTC ~ 2025-11-08 06:28 UTC)
**下一个关键时间点**: 2025-11-07 02:00 UTC (首次 Nightly 运行)
**创建时间**: 2025-11-06
**版本**: 1.0
