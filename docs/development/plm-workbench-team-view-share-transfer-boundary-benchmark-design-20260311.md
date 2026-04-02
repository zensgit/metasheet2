# PLM Workbench Team View Share Transfer Boundary 设计记录

日期: 2026-03-11

## 目标

收紧 `PLM workbench team view` 在 `share / owner transfer` 之后的角色边界，明确：

1. `share` 是管理动作，不是只读动作
2. 当前 `workbenchTeamView` 被转移 owner 后，旧 owner 不应继续复制 canonical deep link
3. 显式 `workbenchTeamView=<id>` 仍然可读，但必须立即退化成只读工作台

## 基线判断

当前 `PLM` 协作对象已经有一套统一的 `permissions` 矩阵：

- backend: [plmCollaborativePermissions.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/plm/plmCollaborativePermissions.ts)
- frontend: [usePlmCollaborativePermissions.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmCollaborativePermissions.ts)

但 `workbench team view` 的运行时 action guard 仍存在一个空隙：

1. 列表接口已经返回 `permissions.canShare = false / canTransfer = false`
2. 旧 owner 打开显式 `workbenchTeamView` deep link 时，UI 会退成只读
3. 但 action 方法如果继续直接依赖 legacy `canManage`，就会和新的权限矩阵产生漂移

这轮要把 `workbench team view` 的 `share / transfer` 运行时守卫彻底对齐到 `permissions`。

## 方案

### 1. workbench action guard 统一走 permissions matrix

在 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts) 中：

1. `shareTeamView()` 改为依赖 `canShareTeamView`
2. `transferTeamView()` 改为依赖 `canManageSelectedTeamView`
3. owner transfer 输入框清理逻辑改为由 [usePlmCollaborativePermissions.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmCollaborativePermissions.ts) 统一负责

这样无论是 stale UI、显式 deep link 还是程序化调用，最终都以 `permissions` 为准。

### 2. 显式 workbench deep link 继续可读

这轮不改变显式 `workbenchTeamView=<id>` 的可读性。

原因：

1. `workbenchTeamView` 已被用作协作入口和 smoke 基线
2. owner transfer 的目标是“移除管理权”，不是“移除阅读权”
3. 旧 owner 仍应能通过同一链接回到当前工作台上下文，只是不能再管理该对象

也就是说：

- `read / apply / duplicate` 保留
- `share / transfer / default / archive / delete` 退出 workbench 主块

### 3. 用真实 owner transfer 做 smoke

验证路径定为：

1. `dev-user` 创建临时 `workbench team view`
2. 转移给已存在的 `plm-transfer-user`
3. 仍以 `dev-user` 打开显式 `workbenchTeamView` deep link
4. 验证：
   - 选中项显示新 owner
   - `应用 / 复制副本` 仍可见
   - `分享 / 转移所有者 / 设为默认 / 归档` 不再出现在 workbench 主块

## 对标与超越目标

对标基线：

1. [plm-panel-team-view-share-owner-boundary-benchmark-design-20260311.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-panel-team-view-share-owner-boundary-benchmark-design-20260311.md)
2. [plm-panel-team-view-readonly-ui-boundary-benchmark-design-20260311.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-panel-team-view-readonly-ui-boundary-benchmark-design-20260311.md)
3. [plm-collaborative-permissions-matrix-benchmark-design-20260311.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-collaborative-permissions-matrix-benchmark-design-20260311.md)

这轮超越点：

1. 把 `workbench team view` 的 action 层也并入统一权限矩阵
2. 不再出现“API 已只读、UI 已只读，但 action guard 还停在 legacy flag”的缝隙
3. 让 `workbench` 和 `documents/cad/approvals` 在协作边界上保持同层级一致性

## 非目标

本轮不做：

1. public share token
2. workbench 协作审批流
3. team view 成员级 ACL
4. cross-tenant share

## 验证计划

代码级：

- [usePlmCollaborativePermissions.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmCollaborativePermissions.spec.ts)
- [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamViews.spec.ts)
- `pnpm --filter @metasheet/web exec vitest run tests/usePlmCollaborativePermissions.spec.ts tests/usePlmTeamViews.spec.ts --watch=false`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-workbench-routes.test.ts`
- `pnpm --filter @metasheet/core-backend build`
- `pnpm lint`

live/browser：

1. 复用已存在用户 `plm-transfer-user`
2. 创建临时 `workbench team view`
3. `transfer -> plm-transfer-user`
4. source user 重新打开显式 deep link
5. 验证：
   - API `permissions` 已退化为只读
   - UI 仍显示同一 `workbenchTeamView` identity
   - `应用 / 复制副本` 仍可见
   - `分享 / 转移所有者 / 设为默认 / 归档` 不再可见
6. cleanup 删除临时 view
