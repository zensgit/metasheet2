# PLM Panel Team View Clear Default URL Sync 设计记录

日期: 2026-03-11

## 目标

为 `Documents / CAD / Approvals team view` 补齐 `clear default` 之后的 URL 一致性。

这轮要解决的不是“能不能取消默认”，而是“取消默认后显式 deep link identity 会不会丢”。

本轮目标有三条：

1. `取消默认` 后，当前显式 panel team view id 仍要留在 URL：
   - `documentTeamView=<id>`
   - `cadTeamView=<id>`
   - `approvalsTeamView=<id>`
2. `取消默认` 后，当前 panel 状态不能被清空：
   - Documents: `documentRole / documentFilter / documentSort / documentSortDir / documentColumns`
   - CAD: `cadFileId / cadOtherFileId / cadReviewState / cadReviewNote`
   - Approvals: `approvalsStatus / approvalsFilter / approvalComment / approvalSort / approvalSortDir / approvalColumns`
3. `clear default` 的行为要和现有 `duplicate / rename / archive / restore / owner transfer / share` 保持同一条 identity 规则。

## 问题基线

当前 `usePlmTeamViews` 在 `clearTeamViewDefault()` 里只做了两件事：

1. 调后端清默认
2. 更新列表里的 `isDefault`

但没有像 team preset 那样重新 `applyView(saved)`。

这会带来一个边界问题：

- 页面内存里的选中项还是当前 team view
- 但 `requestedViewId -> syncRequestedViewId -> query` 这条链不一定会被重新触发
- 在复杂路径下，显式 `documentTeamView / cadTeamView / approvalsTeamView` 可能只存在于“打开时”，而不是“clear default 后的当前状态”

## 方案

### 1. hook 行为对齐

在 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts) 的 `clearTeamViewDefault()` 中，清默认成功后补一条：

- `applyView(saved)`

这样会复用现有统一路径：

1. `syncRequestedViewId(saved.id)`
2. `teamViewKey = saved.id`
3. `applyViewState(saved.state)`

也就是让 `clear default` 自动回到和 `set default / restore / duplicate / rename` 相同的 identity 流程。

### 2. 不新增 panel 特判

这轮不在 `PlmProductView.vue` 里单独为 `Documents / CAD / Approvals` 写分支。

原因是：

- 三个 panel 已经都通过 `requestedViewId + syncRequestedViewId` 接进同一个通用 hook
- 问题发生在通用 lifecycle，而不是某一个 panel 的 query 解析

所以这次只修通用 hook，更符合当前架构方向。

### 3. 验证策略

代码级验证：

- 在 [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamViews.spec.ts) 增一条 focused spec
- 直接锁住：
  - `clear default` 后继续 `syncRequestedViewId('document-view-1')`
  - `applyViewState(saved.state)` 被重新调用
  - `requestedViewId` 与 `teamViewKey` 保持同一个显式 id

live/browser 验证：

1. 创建三条默认 panel team view
2. 直接用显式 deep link 打开 `/plm`
3. 分别点击三个 panel 的 `取消默认`
4. 验证最终 URL 仍保留三个 team view id
5. 验证 `documentFilter / cadReviewNote / approvalsFilter` 仍然保留

## 对标与超越目标

对标基线是上一轮已经收口的：

- `share`
- `duplicate / rename`
- `archive / restore`
- `owner transfer`

这轮超过“普通取消默认按钮”的地方在于：

1. 取消默认不会让显式 deep link identity 掉回匿名状态
2. 取消默认不会吞掉当前 panel 工作上下文
3. 三个 panel 共用同一条 lifecycle 规则，不新增分叉实现

## 非目标

本轮不做：

1. `workbench team view clear default`
2. `BOM / Where-Used team preset clear default`
3. public share token
4. 权限细分

## 验证计划

代码级：

- [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamViews.spec.ts)
- `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts --watch=false`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

live/browser：

1. live API 创建三条默认 panel team view
2. 浏览器进入显式 deep link
3. 依次点击 `Documents / CAD / Approvals` 的 `取消默认`
4. 记录最终 URL 与保留状态
5. 删除临时数据，确认环境恢复
