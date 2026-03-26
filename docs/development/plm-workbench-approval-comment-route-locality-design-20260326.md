# PLM Workbench Approval Comment Route Locality Design

## 背景

前面已经把 `approvalComment` 从 collaborative snapshot、team view 保存和 share URL 里剥掉，语义上它应该只是本地审批动作草稿。

但产品页还有一条 route 链没有收干净：

- `PlmProductView.vue` 的 approvals query watcher 仍会把 `approvalComment` 写回 URL
- `buildDeepLinkUrl()` 仍会把 `approvalComment` 带进复制深链接
- `applyQueryState()` 仍会从 route 里把 `approvalComment` hydration 回本地 state
- `formatDeepLinkTargets()` 仍把本地备注当成 approvals deep-link 状态

结果是本地审批备注会继续泄漏到浏览器地址栏和 deep-link，旧 URL 也会把这份本地草稿重新注入页面。

## 设计目标

1. `approvalComment` 只保留在本地页面状态，不进入 URL、deep-link、分享链路。
2. 旧的带 `approvalComment` URL 打开后，会被 authoritative 地清理掉。
3. approvals 默认 auto-apply 和 deep-link target 判断，不再受本地审批备注影响。

## 方案

### 1. 引入本地 route snapshot 归一化 helper

在 `plmWorkbenchViewState.ts` 中新增：

- `normalizePlmWorkbenchLocalRouteQuerySnapshot(value)`

语义：

- 保留本地 route 里真正需要 round-trip 的 query
- 删除 `approvalComment`
- 继续 canonicalize `panel`

`buildDeepLinkUrl()` 改为基于这份 local-route snapshot 生成 URL，这样当前页复制出来的 deep-link 不会再带审批备注。

### 2. hydration 时主动清掉 legacy approvalComment query

在 `plmWorkbenchViewState.ts` 中新增：

- `buildPlmWorkbenchLegacyLocalDraftQueryPatch(value)`

语义：

- route query 里有 `approvalComment` 时，返回 `{ approvalComment: '' }`
- 没有时返回空 patch

`PlmProductView.vue` 的 `applyQueryState()` 在发现 legacy query 后，不再把它 hydration 回 `approvalComment`，而是通过 deferred query patch 把它从 URL 清掉。

### 3. 停止 approvals route sync 写入 approvalComment

产品页 approvals query watcher 改成只同步：

- `approvalsTeamView`
- `approvalsStatus`
- `approvalsFilter`
- `approvalSort`
- `approvalSortDir`
- `approvalColumns`

`approvalComment` 不再参加 route sync。

同时 `formatDeepLinkTargets()` 也不再把 `approvalComment` 视为 approvals 面板的 deep-link 状态，避免只输入本地审批备注时仍把 deep-link 目标错误标记成 approvals。

## 结果

修复后：

- 审批备注真正只留在本地页面草稿里
- 复制深链接、浏览器地址栏、旧 route hydration 都不再泄漏这份备注
- approvals 默认 auto-apply / deep-link target 判断只基于可复现的共享状态
