# PLM Workbench Approvals Default Query Normalization Design

## 背景

`approvals` 面板和 `documents` 一样支持默认 team view auto-apply。

页面允许通过 route query 显式还原审批面板状态：

- `approvalsTeamView`
- `approvalsStatus`
- `approvalsFilter`
- `approvalComment`
- `approvalSort`
- `approvalSortDir`
- `approvalColumns`

## 问题

默认 `approvals` team view 的 auto-apply blocker 之前仍按原始显式 key 拦截：

- `approvalsStatus=pending`
- `approvalSort=created`
- `approvalSortDir=desc`
- `approvalColumns=<默认列集合>`

这些其实都是 canonical 默认值，deep-link builder 本身也会省略它们。

结果是：

- 旧链接或外部 deep-link 只要显式带了这组默认值
- hydration 后页面仍是默认审批状态
- 默认 `approvalsTeamView` 却不会 auto-apply

## 设计决策

- `approvals` 默认 auto-apply blocker 只认“真实非默认显式状态”
- `approvalComment` 继续视为本地草稿，不参与默认 blocker
- 默认值语义：
  - `approvalsStatus=pending` 不算 blocker
  - `approvalSort=created` 不算 blocker
  - `approvalSortDir=desc` 不算 blocker
  - `approvalColumns` 只有和默认列集合不一致时才算 blocker

## 实现

- 在 [plmWorkbenchViewState.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/plmWorkbenchViewState.ts) 收紧 `hasExplicitPlmApprovalsAutoApplyQueryState(...)`
- 在 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmProductView.vue) 的 `approvals.shouldAutoApplyDefault()` 里把默认列集合一起传入 helper
- 在 [plmWorkbenchViewState.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmWorkbenchViewState.spec.ts) 增加“显式默认 approvals query 不应阻断 auto-apply”的 focused 回归

## 预期结果

- 显式默认审批排序/默认列的旧链接不再误挡默认 `approvalsTeamView`
- 真正的审批过滤、非默认排序、非默认列仍会阻断默认 auto-apply
- `approvals` 和 `documents` 两块默认 blocker 语义一致
