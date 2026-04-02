# PLM Panel Team View Readonly UI Boundary Benchmark Design

日期: 2026-03-11

## 背景

上一轮已经把 `Documents / CAD / Approvals team view share` 收成了 owner-only，但 owner transfer 之后，旧 owner 在显式 deep link 打开的 panel 中仍会看到一整套被禁用的管理按钮。这会产生两个问题：

- 读者态和管理态没有真正分离，界面噪声高。
- 旧 owner 还能看到 `目标用户 ID` 输入框，容易误以为还能继续转移。

## 目标

把 panel team view 的 owner transfer 边界从“禁用管理动作”推进到“只读界面”：

- 非 owner 仍可通过显式 `documentTeamView / cadTeamView / approvalsTeamView` deep link 恢复当前视图。
- 非 owner 仍可执行 `应用`、`复制副本`，保留只读使用能力。
- 非 owner 不再看到管理动作：
  - `分享`
  - `设为默认`
  - `取消默认`
  - `删除`
  - `归档`
  - `恢复`
  - `重命名`
  - `转移所有者`
- 非 owner 不再看到 owner transfer 输入框。

## 设计

### 1. Hook 层增加显式只读信号

在 `/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts` 中新增：

- `canManageSelectedTeamView`
- `showManagementActions`

规则：

- 未选择 team view 时，保留管理区显示，允许保存新视图。
- 已选择且 `canManage = false` 时，进入只读界面，隐藏管理动作。

同时新增 watcher：

- 当当前 selected view 不可管理时，自动清空 `teamViewOwnerUserId`，防止旧输入残留。

### 2. Team Views Block 统一隐藏管理动作

在 `/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmTeamViewsBlock.vue` 中新增 `showManageActions` prop，作为统一门禁：

- `true`: 显示完整管理区
- `false`: 仅保留 `应用 / 复制副本 / 保存到团队`

### 3. Panel Model 显式暴露 showManage* 字段

在 `/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts` 中为：

- workbench
- documents
- cad
- approvals

补入 `showManage*TeamViewActions`，避免继续依赖模板内联判断。

### 4. 父页继续退回编排层

`/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue` 与 `/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmProductPanel.ts` 只负责把 `showManage*` 信号透传给 panel，不再直接写界面分支。

## 对标与超越

本轮不是新增业务能力，而是把协作对象的权限边界从“逻辑正确”推进到“界面正确”：

- 对标：owner-only share / transfer
- 超越：owner transfer 后自动进入只读 UI，而不是残留禁用控制

## 验证计划

1. focused spec：锁住 `showManagementActions = false` 和 owner input 自动清空。
2. web package 全量门禁：`test / type-check / lint / build`
3. live browser smoke：
   - 打开显式 `documentTeamView`
   - 确认视图仍被恢复
   - 确认只剩 `应用 / 复制副本 / 保存到团队`
   - 确认 owner transfer 输入不存在
