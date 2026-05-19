# 考勤 report-records 批量同步 live closeout 开发记录 2026-05-19

## Summary

本 slice 不新增功能代码，只收口 `attendance_report_records` 批量同步 PR #1648 的部署与 live evidence 状态，并修正 TODO 文档中残留的旧范围表述。2026-05-19 追加 staging runtime 更新和 live sync 实测证据。

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

初次尝试 staging live 前置时发现：

- 8082 SSH tunnel 可达，`/api/health` 正常。
- 当前 staging backend 仍运行旧镜像 `5ca91630307603eacbbb13ae8209721f1b4d5bf3`，早于 #1648。
- 本地 staging admin JWT 文件已过期，`/api/auth/me` 返回 401。

该状态先写入 verification MD，未伪造通过。

## Staging Runtime Update

后续收到新的短期 staging admin JWT，并被明确授权更新 staging 后，执行了 staging runtime 更新：

- 尝试拉取最新 `origin/main` docs-only SHA `55f0c949...` 的 GHCR backend/web 镜像，结果为 `manifest unknown`。
- 选择最新可用 runtime main 镜像 `01d4134017febcdac5a95f6ce8898e66a81aa9aa`，该 SHA 是 `55f0c949...` 的祖先且包含 #1648。
- 更新 `/home/mainuser/metasheet2-dingtalk-staging/.env` 的 `IMAGE_TAG`。
- `docker compose pull backend web` 成功。
- 常规 `docker compose up -d backend web` 触发历史 Postgres/Redis 容器名冲突；随后使用 `up -d --no-deps backend web` 仅重建 web/backend，避免触碰 DB/Redis。

更新后 staging 容器：

```text
metasheet-staging-web ghcr.io/zensgit/metasheet2-web:01d4134017febcdac5a95f6ce8898e66a81aa9aa
metasheet-staging-backend ghcr.io/zensgit/metasheet2-backend:01d4134017febcdac5a95f6ce8898e66a81aa9aa
```

## Live Sync Result

使用 staging 上已有的真实 fixture：

- `orgId=default`
- `userId=8b35cbe1-9fd6-4650-9d16-42b2c4d028d1`
- `from=2026-05-15`
- `to=2026-05-17`

结果：

- 首次 sync：`synced=3`、`patched=3`、`failed=0`、`duplicateRowKeys=0`
- 多维表读回：3 行、3 个 distinct row key、`field_fingerprint`/`source_fingerprint`/`synced_at` 全部存在
- 值核对：三天分别为 `480/12/0/late`、`450/0/30/early_leave`、`0/0/0/absent`
- 重跑：`skipped=3`、`created=0`、`patched=0`、`failed=0`

`allUsers` 分页入口也执行了一次，返回 `ok=true`、`userSelection=allUsers`、`totalUsers=0`。这是 staging 环境事实：`user_orgs` 当前为空表，因此第一次只能证明分页入口接受参数，不能证明 active membership 写入路径。

## Active-Membership Bulk Evidence

随后补充一个 staging-only 临时 membership fixture：

- 插入 `user_orgs(default, 8b35cbe1-9fd6-4650-9d16-42b2c4d028d1, true)`
- 执行 `POST /api/attendance/report-records/sync?orgId=default`
- body `{ from: '2026-05-15', to: '2026-05-17', allUsers: true, page: 1, pageSize: 5 }`
- 清理临时 `user_orgs` 行，确认 staging membership state 回到 0

结果：

- `userSelection=allUsers`
- `totalUsers=1`
- `usersScanned=1`
- `usersSynced=1`
- `synced=3`
- `created=0`
- `patched=0`
- `skipped=3`
- `failed=0`
- `duplicateRowKeys=0`

这证明 #1648 的 active-membership bulk branch 可以真实扫描用户、调用 report-records writer，并复用双 fingerprint 幂等 skip。临时 membership 已删除，只保留可重建的 report-records 派生行。
