# PLM Panel Team View Share 设计记录

日期: 2026-03-11

## 目标

为 `Documents / CAD / Approvals team view` 增加显式分享能力，让协作方拿到的是稳定的团队视图 identity，而不是一次性面板状态快照。

本轮目标有三条：

1. `分享` 复制的链接必须显式带上对应 panel team view id：
   - `documentTeamView=<id>`
   - `cadTeamView=<id>`
   - `approvalsTeamView=<id>`
2. 分享链接必须保留当前面板关键状态：
   - Documents: `documentRole / documentFilter / documentSort / documentSortDir / documentColumns`
   - CAD: `cadFileId / cadOtherFileId / cadReviewState / cadReviewNote`
   - Approvals: `approvalsStatus / approvalsFilter / approvalComment / approvalSort / approvalSortDir / approvalColumns`
3. fresh `/plm` 打开分享链接时，必须优先恢复显式 team view，而不是被默认 team view 或 workbench view 覆盖。

## 对标基线

当前 `/plm` 已经有三层可协作 identity：

1. workbench team view
2. panel team view
3. team preset

其中 `Documents / CAD / Approvals team view` 已经具备：

- `save / apply / delete`
- `default / clear default`
- `duplicate / rename`
- `archive / restore`
- `owner transfer`

但还缺一条真正可复用的协作闭环：把当前选中的 panel team view 直接复制成稳定 deep link。

这条能力的要求比 workbench deep link 更严格，因为：

- 分享对象是单个 panel 的长期协作入口
- 分享后必须继续保持 panel team view identity，不允许 silently 回退到 workbench 或 local state
- 后续 `default / archive / transfer` 生命周期都要继续围绕同一个 id 运转

## 方案

### 1. URL 模型

新增共享 URL 构造器：

- [buildPlmWorkbenchTeamViewShareUrl](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmWorkbenchViewState.ts)

生成结果：

- Documents:
  - `panel=documents`
  - `documentTeamView=<id>`
  - `documentRole`
  - `documentFilter`
  - `documentSort`
  - `documentSortDir`
  - `documentColumns`
- CAD:
  - `panel=cad`
  - `cadTeamView=<id>`
  - `cadFileId`
  - `cadOtherFileId`
  - `cadReviewState`
  - `cadReviewNote`
- Approvals:
  - `panel=approvals`
  - `approvalsTeamView=<id>`
  - `approvalsStatus`
  - `approvalsFilter`
  - `approvalComment`
  - `approvalSort`
  - `approvalSortDir`
  - `approvalColumns`

默认值处理：

- Documents 默认 `updated/desc` 不额外回写
- Approvals 默认 `pending`、`created/desc` 不额外回写
- 仅序列化启用列，禁用列不写入 URL

### 2. Hook 职责

在 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts) 中新增：

- `buildShareUrl`
- `copyShareUrl`
- `canShareTeamView`
- `shareTeamView`

约束：

1. 仅当前选中项存在且未归档时允许分享
2. 分享不改变当前选中 view，也不改变当前 URL
3. 分享失败只走消息反馈，不修改当前 panel state

### 3. Panel 接线

在以下 block 中新增 `分享`：

- [PlmProductPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmProductPanel.vue)
- [PlmDocumentsPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmDocumentsPanel.vue)
- [PlmCadPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmCadPanel.vue)
- [PlmApprovalsPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmApprovalsPanel.vue)

由 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 统一透传：

- `shareWorkbenchTeamView / canShareWorkbenchTeamView`
- `shareDocumentTeamView / canShareDocumentTeamView`
- `shareCadTeamView / canShareCadTeamView`
- `shareApprovalsTeamView / canShareApprovalsTeamView`

### 4. 类型边界

为了避免 `share URL` 构造再退回匿名对象，本轮同时补了两条类型收口：

1. [plmWorkbenchViewState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmWorkbenchViewState.ts) 按 `kind` 显式收窄 team view state
2. [usePlmProductPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmProductPanel.ts) 补齐 `shareWorkbenchTeamView / canShareWorkbenchTeamView`

## 超越目标

这轮不只是“复制一个链接”。

真正要超过普通分享按钮的点有三条：

1. 分享出去的是稳定 `team view id`，后续还能承接 `default / archive / transfer`
2. 分享链接带的是足以重建 panel 工作上下文的显式状态，不只是 id
3. fresh `/plm` 打开分享链接时，panel 会继续回到 team view identity，而不是回退成临时状态

## 非目标

本轮不做：

1. public share token
2. 跨租户分享
3. share 权限细化到只读/可编辑
4. panel team view 与 workbench team view 的统一分享弹窗

## 验证计划

代码级：

- [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamViews.spec.ts)
- [plmWorkbenchViewState.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmWorkbenchViewState.spec.ts)
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

live/browser：

1. 创建 3 条 panel team view：
   - documents
   - cad
   - approvals
2. 分别点击 `分享`
3. 捕获复制出的 URL
4. fresh `/plm` 打开链接
5. 验证：
   - team view id 恢复
   - panel 状态恢复
   - URL 仍保持显式 team view identity

cleanup：

删除本轮临时 team view，确认 live 列表回到空状态。
