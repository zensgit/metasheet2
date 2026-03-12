# PLM Collaborative Permissions Matrix Benchmark Design

日期: 2026-03-11

## 背景

当前 `PLM team view / team preset` 的权限边界虽然已经逐步收紧，但实际判定仍分散在两层：

- 后端只返回 `canManage / isArchived / isDefault`
- 前端再根据这三个字段推导 `share / duplicate / archive / restore / default` 等能力

这会带来两个问题：

- 协作语义散在前后端两处，扩一个新动作就要改两遍；
- live API 难以直接表达“当前对象到底允许哪些动作”，测试只能从 UI 反推。

## 目标

把 `PLM collaborative permissions` 收成统一能力矩阵，并让后端直接返回：

- `canManage`
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

同时保持现有顶层 `canManage / isArchived / isDefault` 不变，避免前端已有调用链断裂。

## 设计

### 1. 后端新增统一 matrix builder

新增 `/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/plm/plmCollaborativePermissions.ts`，输入仅依赖：

- `ownerUserId`
- `currentUserId`
- `isArchived`
- `isDefault`

输出统一的 `permissions` 矩阵。这样：

- `team view`
- `team preset`

共用一套约束，不再各自散落。

### 2. row mapper 直接携带 permissions

把 matrix 接入：

- `/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/plm/plmTeamFilterPresets.ts`
- `/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/plm/plmWorkbenchTeamViews.ts`

映射后的返回对象现在同时包含：

- 兼容字段：`canManage / isDefault / isArchived`
- 新字段：`permissions`

### 3. 前端优先消费后端 permissions

前端模型和 client 更新：

- `/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts`
- `/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/plm/plmWorkbenchClient.ts`
- `/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmCollaborativePermissions.ts`

规则：

- 若接口响应带 `permissions`，前端优先使用它；
- 若 live backend 还没重启或返回旧 shape，则自动 fallback 到旧字段推导，保持兼容。

### 4. 行为边界

这轮不改变功能，只改变“权限来自哪里”：

- owner transfer 后的 readonly UI 语义保持不变；
- archived/default 的动作边界保持不变；
- 新增的是“后端直接表达能力矩阵，前端只做消费和兜底”。

## 对标与超越

- 对标：协作对象的 action 可用性在 API 层可见
- 超越：前后端共享同一套权限语义，live API、client、hook、UI 和测试都围绕同一个 matrix 运转

## 验证计划

1. backend focused：
   - 新 matrix builder 单测
   - team preset / team view row mapping 带 `permissions`
2. frontend focused：
   - client 正常解析 `permissions`
   - collaborative hook 优先使用 `permissions`
3. web 门禁：
   - `test`
   - `type-check`
   - `lint`
   - `build`
4. live API：
   - 重启 `7778` backend 进入新代码
   - 创建临时 `BOM team preset`
   - 创建临时 `documents team view`
   - 确认 `create` 与 `list` 返回中都带 `permissions`
   - 清理临时数据
