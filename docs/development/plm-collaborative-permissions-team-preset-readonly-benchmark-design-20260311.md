# PLM Collaborative Permissions Team Preset Readonly Benchmark Design

日期: 2026-03-11

## 背景

上一轮已经把 `Documents / CAD / Approvals team view` 的 owner transfer 边界推进到了真正的只读 UI，但 `BOM / Where-Used team preset` 仍沿用各自独立的权限 computed，导致协作对象之间的权限模型不一致：

- team view 已经进入“只读可应用、不可管理”的协作语义；
- team preset 仍停留在“逻辑禁用 + 局部按钮残留”的状态；
- team preset 与 team view 的 owner-only / archived / default 规则存在重复实现。

## 目标

把 `PLM collaborative permissions` 收成共享模型，并把同样的只读边界扩到 `BOM / Where-Used team preset`：

- 非 owner 仍可通过显式 `bomTeamPreset / whereUsedTeamPreset` deep link 恢复当前 preset；
- 非 owner 仍可执行 `应用 / 复制副本 / 保存到团队`，保留只读使用能力；
- 非 owner 不再看到管理动作：
  - `分享`
  - `归档`
  - `恢复`
  - `重命名`
  - `设为默认`
  - `取消默认`
  - `删除`
  - `转移所有者`
- 切换到不可管理 preset 时，owner transfer 输入值自动清空；
- `team view` 与 `team preset` 共用同一套权限判定，避免后续生命周期再次漂移。

## 设计

### 1. 抽共享权限 helper

新增 `/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmCollaborativePermissions.ts`，统一承载协作对象的权限边界：

- `canManageSelectedEntry`
- `showManagementActions`
- `canApply`
- `canDuplicate`
- `canShare`
- `canDelete`
- `canArchive`
- `canRestore`
- `canRename`
- `canTransfer`
- `canSetDefault`
- `canClearDefault`

同时把 owner transfer 输入清理逻辑也收进去：当选中对象不可管理时，自动清空目标 owner 输入。

### 2. team view / team preset 共用这套模型

在：

- `/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts`
- `/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamFilterPresets.ts`

统一改成消费共享 helper，不再各自维护重复 computed。

### 3. panel model 显式透出只读边界

在 `/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts` 中为 `BOM / Where-Used` 新增：

- `showManageBomTeamPresetActions`
- `showManageWhereUsedTeamPresetActions`

由父页 `/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue` 负责透传给 panel，继续保持“父页只编排，panel 只渲染”。

### 4. BOM / Where-Used preset UI 切到真正只读态

在：

- `/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmBomPanel.vue`
- `/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmWhereUsedPanel.vue`

把管理动作统一挂在 `showManage*TeamPresetActions` 之下。这样非 owner 看到的 team preset 块会退回到：

- `刷新`
- `应用`
- `复制副本`
- `保存到团队`

而不是继续显示一整排禁用管理按钮。

## 对标与超越

- 对标：owner transfer 之后的 deep link 仍可读、可应用；
- 超越：`team view` 和 `team preset` 共享同一套协作权限模型，owner transfer 之后进入真正的只读 UI，而不是只靠禁用按钮维持边界。

## 验证计划

1. focused spec：
   - team preset transfer 后 `showManagementActions = false`
   - team preset transfer 后 `canShare / canTransfer = false`
   - 切到非 owner preset 时清空 owner transfer 输入
2. web package 全量门禁：
   - `test`
   - `type-check`
   - `lint`
   - `build`
3. live browser smoke：
   - 显式 `bomTeamPreset=<id>` 打开 `/plm`
   - 确认选中项仍恢复
   - 确认可见按钮仅剩 `刷新 / 应用 / 复制副本 / 保存到团队`
   - 确认 owner 输入不存在
4. cleanup：
   - 清理本轮创建的临时 BOM 团队预设
