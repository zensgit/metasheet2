# PLM Audit Batch Log Anchor Design

## 背景

[PlmAuditView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue) 的 `runAuditTeamViewBatchAction()` 在批量 `archive / restore / delete` 成功后，会立刻把页面切到对应的 batch audit log route。

这条 route 的锚点由 [buildPlmAuditTeamViewBatchLogState()](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditTeamViewAudit.ts) 的第一个 processed view 决定。

## 问题

之前 `PlmAuditView.vue` 的 fallback 来源错了：

1. `delete` 先把已删除的 team view 从内存列表移除
2. 然后再用 `findAuditTeamViewById(id)` 回找 processed view
3. 找不到时，错误回退到 `eligibleIds`

这样一来，只要：

- `processedIds = ['view-b']`
- `skippedIds = ['view-a']`
- `eligibleIds = ['view-a', 'view-b']`

最终 batch log route 就可能被错误锚到 `view-a`，而 `view-a` 根本不是实际处理成功的对象。

## 设计

把 batch log route 的 processed anchor 收成共享 helper：

1. 在 [plmAuditTeamViewAudit.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditTeamViewAudit.ts) 新增 `resolvePlmAuditProcessedBatchLogViews(...)`
2. helper 逻辑：
   - 优先用 `resolveView(id)` 找当前仍在内存里的 processed view
   - 如果全部找不到，则退回 `processedIds -> { id, kind: 'audit' }`
3. [PlmAuditView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue) 不再回退到 `eligibleIds`

## 结果

- batch audit log route 只会锚到真实 `processedIds`
- `delete` 后对象已从本地列表消失时，route 仍能正确落到 processed target
- skipped view 不会再冒充 batch log anchor
