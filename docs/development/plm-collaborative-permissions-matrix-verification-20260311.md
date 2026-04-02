# PLM Collaborative Permissions Matrix Verification

日期: 2026-03-11

## 变更文件

- `/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/plm/plmCollaborativePermissions.ts`
- `/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/plm/plmTeamFilterPresets.ts`
- `/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/plm/plmWorkbenchTeamViews.ts`
- `/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-collaborative-permissions.test.ts`
- `/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-team-filter-presets.test.ts`
- `/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-workbench-team-views.test.ts`
- `/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts`
- `/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/plm/plmWorkbenchClient.ts`
- `/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmCollaborativePermissions.ts`
- `/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmWorkbenchClient.spec.ts`
- `/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmCollaborativePermissions.spec.ts`

## Focused 验证

backend 已通过：

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-collaborative-permissions.test.ts tests/unit/plm-team-filter-presets.test.ts tests/unit/plm-workbench-team-views.test.ts`

结果：

- `3 files / 13 tests` 全通过
- 确认：
  - matrix builder 能覆盖 owner / transferred / archived 三种状态
  - team preset row mapping 带 `permissions`
  - team view row mapping 带 `permissions`

frontend focused 已通过：

- `pnpm --filter @metasheet/web exec vitest run tests/usePlmCollaborativePermissions.spec.ts tests/plmWorkbenchClient.spec.ts tests/usePlmTeamViews.spec.ts tests/usePlmTeamFilterPresets.spec.ts --watch=false`

结果：

- `4 files / 41 tests` 全通过
- 确认：
  - client 会优先解析接口返回的 `permissions`
  - collaborative hook 会优先使用 `permissions`，而不是只信任旧的 `canManage`

## 包级门禁

已通过：

- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm --filter @metasheet/core-backend build`
- `pnpm lint`

结果：

- `apps/web` 当前为 `31 files / 150 tests`
- `type-check / lint / build` 全绿

## Live API 验证

这轮先重启了 `7778` live backend，让它吃到当前源码；旧进程在重启前不会返回新的 `permissions` 字段。

live artifact：

- `/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-collaborative-permissions-matrix-20260311.json`

确认结果：

- 创建临时 `BOM team preset` 后，`create` 响应已带完整 `permissions`
- 创建临时 `documents team view` 后，`create` 响应已带完整 `permissions`
- 随后的 `list` 结果中，同一 preset/view 也保留了同样的 `permissions`
- 当前矩阵语义为：
  - `canManage = true`
  - `canApply = true`
  - `canDuplicate = true`
  - `canShare = true`
  - `canDelete = true`
  - `canArchive = true`
  - `canRestore = false`
  - `canRename = true`
  - `canTransfer = true`
  - `canSetDefault = true`
  - `canClearDefault = false`

## Cleanup

临时 live 数据已清理：

- `/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-collaborative-permissions-matrix-cleanup-20260311.json`

结果：

- `presetDelete.success = true`
- `viewDelete.success = true`

## 结论

这轮把 `PLM collaborative permissions` 从“前端推导规则”推进到了“后端直接提供 matrix、前端优先消费 matrix、旧字段仅兜底兼容”的状态。

这意味着后续继续扩 `share / transfer / archive / default` 时，主语义只需要在一处定义，不必再前后端各写一套。
