# PLM Audit Kind Selector Contract Design

## 背景

[plmAuditTeamViewAudit.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditTeamViewAudit.ts) 在 team-view lifecycle/default 日志态里会显式产出 `kind: 'audit'`。

同一个值也已经被：

- [plmAuditQueryState.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditQueryState.ts)
- [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/plmPanelModels.ts)

当成合法 route/state 合同。

## 问题

但 [PlmAuditView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue) 的 Kind 下拉之前没有 `audit` 选项。

结果就是：

1. 页面 state 已经合法地落在 `auditKind=audit`
2. route hydration 能恢复它
3. UI 下拉却无法显示或重新选择这个值

这会让当前过滤状态和可见控件脱节。

## 设计

把 Kind 选项收成共享常量：

1. 新增 [plmAuditFilterOptions.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditFilterOptions.ts)
2. `PLM_AUDIT_KIND_OPTIONS` 明确包含：
   - `audit`
3. [PlmAuditView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue) 改为消费这份常量，而不是手写一组遗漏了 `audit` 的 `<option>`

## 结果

- Kind selector 和 route/state 合同重新一致
- audit team-view 日志态不再落入“UI 无法表达当前值”的灰区
