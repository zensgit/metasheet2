# 考勤 report-records 批量同步 live closeout 开发记录 2026-05-19

## Summary

本 slice 不新增功能代码，只收口 `attendance_report_records` 批量同步 PR #1648 的部署与 live evidence 状态，并修正 TODO 文档中残留的旧范围表述。

PR #1648 已将 `POST /api/attendance/report-records/sync` 从单员工 v1 扩展为：

- 旧兼容：`{ from, to, userId }`
- 显式批量：`{ from, to, userIds }`
- 全员分页：`{ from, to, allUsers: true, page, pageSize }`

## Changes

- `docs/development/attendance-report-records-sync-todo-20260515.md`
  - 修正 Out-of-scope 中“全员同步/分页仍 follow-up”的旧口径。
  - 保留 `batch cursor / 后台任务队列` 为后续项。
  - 修正 Assumptions 中“userId v1 必填”的旧口径，说明旧单员工路径仍兼容，但也支持 `userIds` 和 `allUsers`。
- 新增本 development MD。
- 新增 live closeout verification MD。

## Deployment Finding

GitHub Actions 显示 #1648 merge commit `2f211d161a301bc632165f9909b604cc05e5559a` 已触发并完成 production deploy：

- Workflow: `Deploy to Production`
- Run id: `26069092327`
- Head SHA: `2f211d161a301bc632165f9909b604cc05e5559a`
- Conclusion: `success`

远端容器也显示 production backend 已运行同一镜像 SHA：

```text
metasheet-backend ghcr.io/zensgit/metasheet2-backend:2f211d161a301bc632165f9909b604cc05e5559a
```

## Live Evidence Boundary

本轮未对 production 执行 report-records sync 写入。原因：

- #1648 的 deploy 已经在 production 确认。
- allUsers/pageSize 是写入派生多维表的管理员动作，即使是可重建报表层，也不应在 production 上无明确样本授权地触发。

尝试 staging live 前置时发现：

- 8082 SSH tunnel 可达，`/api/health` 正常。
- 当前 staging backend 仍运行旧镜像 `5ca91630307603eacbbb13ae8209721f1b4d5bf3`，早于 #1648。
- 本地 staging admin JWT 文件已过期，`/api/auth/me` 返回 401。

因此 staging allUsers/pageSize live sync 暂不可真实执行。该状态写入 verification MD，不伪造通过。

## Next Step

若要补真实 live sync evidence，需要先满足：

1. 将 staging backend 更新到包含 #1648 的镜像，或提供一个已更新的测试环境。
2. 生成新的短期 staging admin JWT 文件。
3. 使用小 pageSize（建议 `pageSize=1`）触发 `allUsers` 分页 sync。
4. 核对 `attendance_report_records` 中的 `field_fingerprint`、`source_fingerprint`、`synced_at` 和 row count。
