# 考勤 Period Rollup live closeout 设计记录

Date: 2026-05-19

## Summary

本 slice 收口 `attendance_report_period_summaries` 的 staging live evidence。PR1 descriptor / ensure、PR2 writer / route、PR3 前端入口均已合并；本轮不新增功能代码，只执行 staging runtime 更新、真实同步、读回核验，并补充设计与验证记录。

边界不变：

- `attendance_*` 仍是事实源。
- `attendance_report_period_summaries` 只做可重建周期汇总快照。
- 写入只通过 `POST /api/attendance/report-period-summaries/sync` 触发插件 writer。
- 不新增 migration，不让多维表公式直读 `attendance_*`。
- 本轮只写 staging，不写 production。

## Runtime Update

PR #1662 merge commit：

```text
dc31d86688956bd474a3e3d65ca343c1672cbb16
```

staging 原 backend / web image：

```text
01d4134017febcdac5a95f6ce8898e66a81aa9aa
```

staging 更新目标 backend / web image：

```text
ghcr.io/zensgit/metasheet2-backend:dc31d86688956bd474a3e3d65ca343c1672cbb16
ghcr.io/zensgit/metasheet2-web:dc31d86688956bd474a3e3d65ca343c1672cbb16
```

只重建 backend / web：

- `docker compose -f docker-compose.app.staging.yml pull backend web`
- `docker compose -f docker-compose.app.staging.yml up -d --no-deps backend web`

`--no-deps` 保证 staging Postgres / Redis 不被重建。

## Auth Handling

旧 staging JWT 已过期，`/api/auth/me` 返回 `401 Invalid token`。本轮重新签发短期 admin JWT 到本地私有文件，权限为 `0600`，并通过 `/api/auth/me` 验证。

约束：

- token 内容不打印。
- JWT secret 不打印。
- 文档只记录文件式读取方式，不记录 token 值。

## Live Sync Coverage

本轮覆盖四条 live 路径：

1. date range + single user：`2026-05-15..2026-05-17`，样本用户 `8b35cbe1-9fd6-4650-9d16-42b2c4d028d1`。
2. date range rerun：同一 row key 重跑应通过 source + field fingerprint 进入 `skipped=1`。
3. payroll cycle + single user：使用 staging 已存在 cycle `4a3173ab-4065-42f3-bbeb-cb02b4807db2`。
4. allUsers pagination：staging 原 `user_orgs` 为 0；临时插入 1 条 active membership，跑完后删除回 0。

## Readback Strategy

读回只用于验证，不改变产品边界：

- 通过 staging DB 查询 `meta_records` / `meta_fields` 验证私有多维表行。
- 核对 row count、distinct row key、`field_fingerprint`、`source_fingerprint`、`synced_at`。
- 核对 date range 行的汇总值：`total_work_minutes=930`、`total_late_minutes=12`、`total_early_leave_minutes=30`。

## Follow-up

后续若要把 period summaries 作为运营日常验收，可再补一个专用 `scripts/ops/attendance-report-period-summaries-live-acceptance.mjs`。本轮按既有 closeout 纪律手动执行，不把 live harness 纳入此 docs-only slice。
