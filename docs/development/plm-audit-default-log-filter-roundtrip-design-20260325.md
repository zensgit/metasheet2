# PLM Audit Default-Log Filter Roundtrip Design

## 背景

[PlmAuditView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue) 已经允许用户把审计筛选设置成：

- `action = set-default`
- `action = clear-default`
- `resourceType = plm-team-view-default`

同一组值也已经被：

- [plmAuditQueryState.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditQueryState.ts)
- [plmAuditTeamViewAudit.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditTeamViewAudit.ts)

当成合法的 audit route/state 合同。

## 问题

但 [plmWorkbenchClient.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/services/plm/plmWorkbenchClient.ts) 里的 `normalizeTeamViewState(kind === 'audit')` 仍然只接受旧的 batch lifecycle 枚举：

- `action = archive | restore | delete`
- `resourceType = plm-team-preset-batch | plm-team-view-batch`

结果是：

1. 页面可以设置并保存 `set-default / clear-default`
2. 请求体会把这些值发给后端
3. 但 client 在读取保存结果或重新 list team views 时，又把它们归一化成空字符串

这会让 audit team view 出现“可保存、不可读回、不可重放”的自我打架。

## 设计

把 audit team-view 的 client-side normalize 合同补齐到和 route/state/UI 一致：

1. `action` 增加接受 `set-default`、`clear-default`
2. `resourceType` 增加接受 `plm-team-view-default`
3. 用 client spec 同时锁住：
   - `savePlmWorkbenchTeamView('audit', ...)` 的返回值 round-trip
   - `listPlmWorkbenchTeamViews('audit')` 的读取 round-trip

## 结果

- audit team view 保存默认日志筛选后，不会被 client 自己抹掉
- 重新拉取 team views 时，也能稳定恢复这组筛选
- client normalize、audit route state、页面控件三层合同重新一致
