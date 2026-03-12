# PLM Panel Team View Archive Restore 对标设计

日期: 2026-03-10

## 目标

前几轮已经把 `PLM workbench team view` 的 `archive / restore` 收到了稳定状态，但 `Documents / CAD / Approvals` 三类面板视图还停在：

1. `save`
2. `set default`
3. `clear default`
4. `delete`
5. 显式 `documentTeamView / cadTeamView / approvalsTeamView` deep link

还缺同一层级的软退出路径：

1. 当前面板团队视图支持 `archive`
2. 归档后只退出对应面板的 URL identity
3. 当前面板状态继续保留为匿名工作态
4. 已归档视图支持 `restore`
5. 恢复后回到同一个 team view id

本轮目标就是把这段生命周期补到 `Documents / CAD / Approvals`。

## 对标判断

对标 `Notion archived database view`、`Retool saved view archive`、`Linear archived workflow view`，成熟工作台都会遵守一条规则：

`archive 是当前 identity 退场，不是当前面板状态丢失。`

落实到 `/plm` 上就是：

1. 文档归档只退出 `documentTeamView`
2. CAD 归档只退出 `cadTeamView`
3. 审批归档只退出 `approvalsTeamView`
4. `documentRole / documentFilter / sort`
5. `cadFileId / cadOtherFileId / cadReviewState / cadReviewNote`
6. `approvalsStatus / approvalsFilter / approvalComment / sort`

都必须保留。

如果归档一个面板视图时把其它面板 identity 一起打掉，deep link 会串面板。  
如果归档时把当前面板状态一起清掉，用户会丢失正在工作的上下文。  
如果恢复后换成新 id，历史链接也会断。

## 设计决策

### 1. 不新增后端协议，直接复用现有 generic team view 生命周期

后端 [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/plm-workbench.ts) 和 [plmWorkbenchTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/plm/plmWorkbenchTeamViews.ts) 已经支持：

1. `POST /api/plm-workbench/views/team/:id/archive`
2. `POST /api/plm-workbench/views/team/:id/restore`
3. `isArchived`
4. `archivedAt`

所以本轮不重复造协议，而是把前端缺失的 `Documents / CAD / Approvals` 接线补齐。

### 2. 三个 panel model 统一暴露 archive / restore 能力

在 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts) 为：

1. `PlmDocumentsPanelModel`
2. `PlmCadPanelModel`
3. `PlmApprovalsPanelModel`

新增：

1. `archive*TeamView`
2. `restore*TeamView`
3. `canApply*TeamView`
4. `canArchive*TeamView`
5. `canRestore*TeamView`

这样三个面板能和 `PlmTeamViewsBlock` 使用同一套能力模型，而不是继续停留在“只有 delete/default”的半生命周期。

### 3. UI 归档后只退出对应面板 identity

前端继续复用 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts) 的通用逻辑：

1. `archiveTeamView()` 清当前面板 `teamViewKey`
2. 如果当前 `requestedViewId` 命中该 view，则 `syncRequestedViewId(undefined)`
3. 当前面板状态不重置

所以：

1. 文档归档后只清 `documentTeamView`
2. CAD 归档后只清 `cadTeamView`
3. 审批归档后只清 `approvalsTeamView`

其它 query 与当前字段值保持不变。

### 4. restore 用原 id 回到 URL

恢复动作同样沿用通用 hook：

1. 后端去掉 `archived_at`
2. 前端替换当前 team view 行
3. 通过 `applyView(saved)` 重新同步 `requestedViewId`
4. 原 id 重新回到 URL

这保证：

1. 显式 deep link 可逆
2. 恢复前后的分享链接仍稳定

### 5. Apply 按钮也必须感知 archived 状态

这轮不只是补两个按钮。  
如果 panel 不把 `canApplyTeamView` 透给 [PlmTeamViewsBlock.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmTeamViewsBlock.vue)，已归档视图仍会显示成可应用，用户点下去才收到错误提示。

所以本轮一并补上：

1. `canApplyDocumentTeamView`
2. `canApplyCadTeamView`
3. `canApplyApprovalsTeamView`

让归档态在按钮层直接禁用。

## 超越目标

本轮的价值不是“文档/CAD/审批各多两个按钮”，而是把 `PLM panel team view` 生命周期从不对称状态拉平：

1. `workbench` 有 archive / restore
2. `documents / cad / approvals` 现在也有 archive / restore
3. `save / default / delete / deeplink / archive / restore` 行为模型一致

这让 `/plm` 的多面板团队视图第一次具备统一的资源语义，而不是每个面板各自一套半成品规则。

## 本轮不做

- 不做 `documents / cad / approvals` team view 的 duplicate / rename
- 不做 archive list 独立分页
- 不做恢复后自动设默认
- 不做更细的 owner transfer / share 权限

本轮只解决一件事：

让 `Documents / CAD / Approvals team view` 在 `archive / restore` 后，URL identity、当前面板状态和目录可见性保持一致。
