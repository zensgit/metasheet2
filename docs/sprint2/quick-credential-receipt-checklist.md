# Sprint 2 Staging Credential Receipt – 10 Minute Checklist

状态: 待凭证 (BASE_URL + JWT)。凭证一旦到达，严格按序执行，避免遗漏。

## 0. 前置安全
1. 不在终端输出或复制 JWT 全值到聊天/文档。
2. 确认当前分支 `feature/sprint2-snapshot-protection` 且工作区干净 (`git status` 无未提交变更)。

## 1. 环境变量导入 (T0)
```bash
export STAGING_BASE_URL="<paste-url>"
export STAGING_JWT="<paste-jwt-token>"
echo "BASE_URL len: ${#STAGING_BASE_URL}; JWT len: ${#STAGING_JWT}"  # 仅长度检查
```
不再打印 token 内容。

## 2. 健康预检 (≤2 分钟)
```bash
bash scripts/staging-health-loop.sh 7  # 7 次循环，全为 GREEN 才继续
```
若出现 RED：记录到 `docs/sprint2/staging-validation-report.md` 的故障章节，暂停继续并通知。

## 3. 全量验证执行 (启动 T+2 分钟)
首选自动包装脚本：
```bash
bash /tmp/execute-staging-validation.sh "$STAGING_JWT" "$STAGING_BASE_URL"
```
若不存在则手动：
```bash
API_TOKEN="$STAGING_JWT" BASE_URL="$STAGING_BASE_URL" pnpm run staging:validate
API_TOKEN="$STAGING_JWT" BASE_URL="$STAGING_BASE_URL" pnpm run staging:perf
API_TOKEN="$STAGING_JWT" BASE_URL="$STAGING_BASE_URL" pnpm run staging:schema
```

## 4. 证据与快照 (并行 T+5 分钟)
```bash
bash scripts/capture-metrics-snapshot.sh
DATABASE_URL="$STAGING_DB_URL" bash scripts/capacity-snapshot.sh || true  # 若可用
```
截图：Grafana / Prometheus → 保存至 `docs/sprint2/screenshots/`:
```
latency-dashboard.png
prom-metrics-panel.png
rule-eval-counters.png
```

## 5. Diff 分析 (T+7 分钟)
```bash
bash scripts/metrics-diff.sh docs/sprint2/evidence/metrics-snapshot-local.prom.txt docs/sprint2/evidence/metrics-snapshot-staging.prom.txt || true
bash scripts/perf-diff.sh docs/sprint2/performance/local-perf.summary.json docs/sprint2/performance/staging-perf.summary.json || true
```
输出要点写入 staging 验证报告 Performance & Metrics Delta 部分。

## 6. 报告与 PR 更新 (T+9 分钟)
填充占位：`docs/sprint2/staging-validation-report.md` → 所有 _[Fill: ...]_。
```bash
pnpm run staging:pr-body
git add docs/sprint2/
git commit -m "docs(sprint2): add staging validation evidence"
git push
```

## 7. 安全终检 (T+10 分钟)
```bash
bash scripts/secret-scan.sh 2>&1 | tee docs/sprint2/secret-scan-latest.md
```
结果 = “No secret patterns found.” 才允许：
```bash
gh pr edit <PR_NUMBER> --body "$(cat docs/sprint2/pr-description-draft.md)"
gh pr ready <PR_NUMBER>
gh pr comment <PR_NUMBER> --body "✅ Staging validation complete. All gates passed."
```

## 8. 回滚预案 (仅异常触发)
若性能失败：保留证据，添加标签 `needs-staging-performance-fix`，不回滚。
若功能性失败（关键 API 401/5xx）：暂不标记 ready，创建 Issue “Staging Validation – Blockers”。
若安全扫描发现泄漏：立即 `git reset --hard HEAD~1` 删除提交，重新执行步骤 3-7。

## 9. 清理
```bash
unset STAGING_JWT  # 最小暴露窗口
```bash

完成后将本清单链接加入报告“Execution Checklist”章节。

