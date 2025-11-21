# Sprint 2 Conditional Merge Plan (无 Staging 凭证 >48h 场景)

目标: 若 48h 仍未获取 BASE_URL + JWT，执行“局部验证合并”并保留可追溯后续 Staging 验证路径。

## 1. 合并前确认清单
- 本地验证: 17/17 ✅
- 性能: P95 43ms / P99 51ms ✅ (阈值 150 / 250)
- 错误率: 0% ✅
- 文档完整: 报告/风险/回滚/诊断 ✅
- Secret 扫描: 最新结果无泄漏 ✅
- PR 草稿: 已包含 Local-only 状态章节 ✅

## 2. 合并标签与 PR 状态
将添加标签:
- `local-validation-only`
- `needs-staging-validation`

PR 描述增加区块:
```
### Post-Merge Staging Validation (Pending Credentials)
Status: BLOCKED – awaiting BASE_URL + JWT.
Actions queued (scripts): staging-health-loop.sh, execute-staging-validation.sh, metrics-diff.sh, perf-diff.sh.
Rollback triggers: critical API 5xx on staging; data integrity failure in snapshot diff; latency P95 > 2x baseline.
```

## 3. 合并后 4 阶段执行
| 阶段 | 时间 | 条件 | 动作 |
|------|------|------|------|
| Phase A | T+0h | 合并完成 | 留存 watcher，创建 Issue “Post-Merge Staging Validation” (若未自动) |
| Phase B | T+24h | 凭证仍缺失 | 升级标签 `escalated-staging-delay`；发布进度说明 |
| Phase C | 凭证到达 | 任意时间 | 按 quick checklist 10 分钟流程执行；更新 PR 评论 |
| Phase D | 验证失败 | 立即 | 建立回滚/补救 Issue，视严重性决定 revert or patch |

## 4. 回滚策略
条件触发:
- 核心功能性失败 (snapshot create 5xx >3 次 / rule evaluate 崩溃)
- 数据完整性: diff 出现结构字段缺失 (>10% items missing)
- 性能退化: P95 >300ms 且持续 3 轮
- 安全/泄漏: secret 扫描发现敏感值

动作:
1. 标记 PR: `rollback-pending`
2. 创建 Issue: “Sprint 2 – Emergency Rollback” (含证据路径)
3. 执行 revert: `git revert <merge_commit>`
4. 通知频道 & 列出重新验证计划

## 5. Post-Merge 验证命令包
```bash
export STAGING_BASE_URL="<url>"; export STAGING_JWT="<token>"
bash scripts/staging-health-loop.sh 5 || exit 2
bash /tmp/execute-staging-validation.sh "$STAGING_JWT" "$STAGING_BASE_URL"
bash scripts/capture-metrics-snapshot.sh
DATABASE_URL="$STAGING_DB_URL" bash scripts/capacity-snapshot.sh || true
bash scripts/metrics-diff.sh docs/...local.prom.txt docs/...staging.prom.txt || true
bash scripts/perf-diff.sh docs/...local_perf.json docs/...staging_perf.json || true
bash scripts/secret-scan.sh | tee docs/sprint2/secret-scan-post-merge.md
```

## 6. 数据与证据路径规范
- Staging perf: `docs/sprint2/performance/staging-perf-<ts>.summary.json`
- Staging metrics: `docs/sprint2/evidence/metrics-snapshot-staging-<ts>.prom.txt`
- Capacity: `docs/sprint2/capacity/staging-capacity-<ts>.json`
- Screenshots: `docs/sprint2/screenshots/*-staging.png`
- Diff outputs: `docs/sprint2/evidence/{metrics,perf}-diff-<ts>.txt`

## 7. 风险与缓解映射
| 风险 | 等级 | 缓解 |
|------|------|------|
| 无凭证导致长时间阻塞 | 高 | 条件合并 + 后置验证 |
| 合并后发现功能缺陷 | 中 | Post-merge verifier + rollback plan |
| 性能退化晚发现 | 中 | health-loop + smoke 脚本周期执行 |
| 证据缺失 | 低 | 强制路径和命名规范 |

## 8. 成功完成标志
- 所有 Staging MUST PASS 重新验证项目完成
- PR 评论追加 “Post-merge staging validation PASS”
- 标签移除: `needs-staging-validation`, `local-validation-only`
- 新增标签: `staging-validated`

## 9. 维护
本文件在 >48h 决策触发前不修改；触发后若执行回滚或补救，再补充版本历史。

