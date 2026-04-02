# PLM Audit Generic Delete Log-Route Design

## Background

`PLM Audit` 的 team-view 删除入口有两条：

- management 列表/批量 lifecycle action
- 顶部 generic team-view controls

卡片和批量 lifecycle action 已经会在删除后切到显式的 `delete` audit log route。

## Problem

在本次修改前，顶部 generic `Delete` 仍然保留一套独立实现：

- 删除 team view
- 本地清空 `teamViewId`
- 用 `{ ...readCurrentRouteState(), teamViewId: '' }` 同步 route

这会导致 generic `Delete` 只是“清掉当前 team view 选择”，而不是明确切到 `delete` log route。

当页面已经停在：

- `set-default` followup/log route
- `clear-default` followup/log route
- 其他 `teamViewId=''` 的日志态

generic `Delete` 甚至可能不触发新的 route 切换，页面会继续停在旧日志上下文。

## Decision

顶部 generic `Delete` 不再维护独立删除语义，直接复用现有 lifecycle `delete` 路径。

这样所有删除入口统一满足同一合同：

- 删除 team view
- 清理 selection / management attention
- 切到 `buildPlmAuditTeamViewLogState(view, 'delete', ...)`
- 显示 “Showing matching audit logs” 状态文案

## Implementation

Files:

- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditTeamViewAudit.spec.ts`

Key changes:

- `deleteAuditTeamView()` 改为直接委托 `runAuditTeamViewLifecycleAction(view.id, 'delete')`
- 单视图 `delete` log route 预期补到 focused spec，锁定：
  - `action: 'delete'`
  - `resourceType: 'plm-team-view-batch'`
  - `teamViewId: ''`
  - `returnToPlmPath` 继续保留

## Expected Behavior

- 顶部 generic `Delete` 与卡片/批量 `Delete` 现在走同一套删除后路由语义
- 如果当前已经停在别的 log/followup route，generic `Delete` 仍会切到新的 `delete` audit log route
- 删除不会再只是“清选择”，而是明确进入 delete log 上下文
