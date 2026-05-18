# 考勤公式真实 Evaluation Acceptance 开发说明

## Summary

本 slice 是 #1617 后的验收计划收口，不新增产品代码。目标是把真实 staging 公式 evaluation 的输入、执行方式、验收标准和暂缓项写清楚，避免继续开发更大的公式能力前缺少端到端证据。

## Deliverable

新增 TODO：

- `docs/development/attendance-formula-live-evaluation-acceptance-todo-20260517.md`

该 TODO 固化：

- 为什么先补真实 formula evaluation acceptance。
- 需要的 staging 输入。
- 推荐 seed 字段 `net_anomaly_minutes`。
- seed API 调用方式。
- live acceptance 命令。
- 脱敏与边界要求。
- 依赖图/循环检测为何暂缓。

## Design Decision

选择“真实 evaluation acceptance”作为下一步，而不是立即开发“公式字段依赖图与循环检测”：

- v1 validator 已拒绝 formula-to-formula。
- v1 custom 非公式字段不作为公式源。
- 因此当前没有真实运行时公式循环风险。
- 依赖图应随 formula-to-formula 或 custom source v2 一起做，否则会成为展示/预留功能，不能提高当前正确性。

## Boundary

- 不写代码。
- 不触 staging，因为当前没有新的 staging JWT、样本 userId、日期范围。
- 不伪造 live acceptance 通过。
- 不改 `attendance_*`，不写 `meta_*`。

## Next Operator Action

提供以下输入后执行 TODO 中的命令：

- `API_BASE`
- `AUTH_TOKEN_FILE`
- `orgId`
- `userId`
- `from`
- `to`

然后 seed `net_anomaly_minutes` 并运行 `EXPECT_FORMULA_CODE=net_anomaly_minutes` 的 live acceptance。
