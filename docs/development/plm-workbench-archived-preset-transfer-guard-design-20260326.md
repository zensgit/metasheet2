# PLM Workbench Archived Preset Transfer Guard Design

## 背景

前端 `team preset` 已经禁止对 archived preset 执行 `transfer-owner`，但后端 transfer route 仍允许直接 API 调用修改 archived preset 的 owner。

## 问题

- `team view` transfer route 已有 archived guard
- `team preset` transfer route 缺少对应分支
- 结果是 direct API caller 仍可绕过前端，把 archived team preset 转移给别的用户

## 设计决策

- 与 `team view` 语义完全对齐
- archived team preset 在 transfer route 上直接返回 `409`
- 错误文案采用显式 preset 版本，避免与 view 混淆

## 实现

- 在 `packages/core-backend/src/routes/plm-workbench.ts`
  - `preset.owner_user_id !== currentUserId` 之后
  - `targetOwnerUserId === currentUserId` 之前
  - 新增 `preset.archived_at` guard

## 预期结果

- archived team preset 不再能通过 API 执行 ownership transfer
- 前后端 lifecycle 合同对齐
- 与 archived team view transfer 行为保持一致
