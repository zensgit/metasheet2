# PLM Audit Local Save Name Gating Design

Date: 2026-03-24

## Problem

`Saved views` 区域的 `Save current view` 之前有一条明显的 UI/handler 契约错位：

- 按钮始终可点
- 输入框回车也始终会触发保存
- 但真正的保存实现会在运行时拒绝空名称

结果是用户在空名称状态下会得到一次错误提示，而不是在交互层被正确阻止。

这条 mismatch 对应的本地证据是：

- [PlmAuditView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue) 里 `Save current view` 按钮之前没有 `:disabled`
- [PlmAuditView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue) 里的 `storeAuditSavedViewState(...)` 已经会拒绝空名称

这轮我也用已登录的 `Claude Code` 做了定点只读校验，它给出了同样的结论。

## Design

### 1. 让本地 saved-view 名称校验成为共享合同

[plmAuditSavedViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditSavedViews.ts) 现在显式导出 `canSavePlmAuditSavedViewName(...)`。

这样名称有效性的定义不再散在：

- 本地 storage 写入层
- 页面按钮启停
- 回车提交守卫

都走同一条规则：`Boolean(name.trim())`

### 2. 提前在 UI 层拦住无效提交

[PlmAuditView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue) 新增了 `canSaveCurrentAuditView`，并把它接到：

- `Save current view` 按钮 `:disabled`
- 输入框回车提交
- `saveCurrentView()`
- `saveCurrentAuditView()`

这样不论是点按钮、按回车，还是未来有别的调用路径，都不会再进入空名称错误分支。

### 3. 保持 storage 层幂等

这轮没有移除 storage 层的空名称保护。

目的不是把保护从底层搬到 UI，而是：

- UI 层先防误触
- 底层继续防御式拒绝无效写入

## Files

- [PlmAuditView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue)
- [plmAuditSavedViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditSavedViews.ts)
- [plmAuditSavedViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmAuditSavedViews.spec.ts)

## Non-goals

- 不改变 local saved view 的 snapshot 语义
- 不改变 saved-view followup / promotion / collaboration takeover 逻辑
- 不引入新的组件测试栈
