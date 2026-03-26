# PLM Workbench Archived View Rename Guard Design

## 背景

`team view` 和 `team preset` 的 mutating route 绝大多数都已经禁止对 archived 目标继续做管理动作。

`team preset rename` 也早就有 archived guard。

## 问题

`PATCH /api/plm-workbench/views/team/:id` 之前是这组 route 里的例外：

- 先校验 owner
- 直接进入 no-op rename / duplicate-name / update 分支
- 完全跳过 `archived_at` 检查

结果是已经归档的 `team view` 仍然能被后端重命名，和 UI gating、preset rename、其它 lifecycle/default/transfer 路径都不一致。

## 设计决策

- `team view rename` 和 `team preset rename` 语义完全对齐
- archived target 一律返回 `409`
- 错误文案保持显式：
  - `Archived PLM team views cannot be renamed`

## 实现

- 在 [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/core-backend/src/routes/plm-workbench.ts) 的 `PATCH /api/plm-workbench/views/team/:id` owner 检查后新增 `archived_at` guard
- 在 [plm-workbench-routes.test.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/core-backend/tests/unit/plm-workbench-routes.test.ts) 补 focused regression，锁住 archived rename 必须返回 `409`

## 预期结果

- archived `team view` 不能再通过 rename route 被修改
- `team view rename`、`team preset rename`、其它 mutating route 的 archived 语义保持一致
