# PLM Panel Team View Set Default URL Sync 设计记录

日期: 2026-03-11

## 目标

验证并锁定 `Documents / CAD / Approvals team view` 在 `set default` 之后的 URL 一致性。

这一轮的目标不是新增按钮，而是把现有 lifecycle 的正确行为固化成明确协议：

1. `设为默认` 后，当前显式 panel team view id 必须继续留在 URL：
   - `documentTeamView=<id>`
   - `cadTeamView=<id>`
   - `approvalsTeamView=<id>`
2. `设为默认` 后，当前 panel 状态不能被覆盖或回退：
   - Documents: `documentRole / documentFilter / documentSort / documentSortDir / documentColumns`
   - CAD: `cadFileId / cadOtherFileId / cadReviewState / cadReviewNote`
   - Approvals: `approvalsStatus / approvalsFilter / approvalComment / approvalSort / approvalSortDir / approvalColumns`
3. `set default` 的 identity 行为要与：
   - `duplicate / rename`
   - `archive / restore`
   - `share`
   - `owner transfer`
   - `clear default`
   处于同一条规则链上。

## 基线判断

当前 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts) 的 `setTeamViewDefault()` 已经具备关键路径：

1. `setPlmWorkbenchTeamViewDefault(...)`
2. `teamViews.value = applyDefaultTeamViewUpdate(...)`
3. `lastAutoAppliedDefaultId.value = saved.id`
4. `applyView(saved)`

也就是说，代码层已经在复用同一条 `applyView -> syncRequestedViewId -> query` 流程。

这轮的重点不是修一个缺失调用，而是补两类护栏：

1. focused spec
2. live/browser smoke

## 方案

### 1. focused spec 锁定显式 documents identity

在 [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamViews.spec.ts) 新增一条专门的 `documents` 用例，验证：

1. `setTeamViewDefault()` 调用后继续 `syncRequestedViewId('document-view-2')`
2. `requestedViewId` 保持 `document-view-2`
3. `teamViewKey` 保持 `document-view-2`
4. `isDefault = true`
5. `applyViewState(saved.state)` 被重新调用

这样可以把“设默认后显式 deep link 不丢”固定成 hook 级契约。

### 2. live/browser 走完整三 panel 路径

live 层创建三条非默认 panel team view：

- Documents
- CAD
- Approvals

然后直接用显式 deep link 打开 `/plm`，在同一页依次点击三个 panel 的 `设为默认`，观察：

1. URL 是否仍保留三个显式 id
2. 三个 panel 是否都进入 `· 默认`
3. 当前状态是否保持：
   - `documentFilter`
   - `cadReviewNote`
   - `approvalsFilter`

### 3. 不新增 panel 特判

这轮仍然坚持只走通用 hook，不在 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 写 panel 级特判。

原因：

- 三个 panel 都已经走 `requestedViewId + syncRequestedViewId`
- `set default` 需要锁定的是通用 lifecycle，而不是某一段 query parser

## 对标与超越目标

对标基线是上一轮刚补完的：

- `clear default URL sync`

这轮超越点在于：

1. `set default` 与 `clear default` 形成成对生命周期闭环
2. `default` 切换前后，panel identity 都保持稳定
3. 通过 live/browser 证明：
   - `set default` 不会把显式 deep link 降级成“只有默认，没有 identity”

## 非目标

本轮不做：

1. 权限细化
2. public share token
3. workbench team view set default 补逻辑
4. BOM / Where-Used team preset set default 补逻辑

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

1. API 创建三条非默认 panel team view
2. 显式 deep link 打开 `/plm`
3. 依次点击 `Documents / CAD / Approvals` 的 `设为默认`
4. 记录最终 URL 与状态保留情况
5. 删除临时数据，确认环境恢复
