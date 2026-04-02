# PLM Collaborative Audit Query/Export 设计记录

日期: 2026-03-11

## 目标

把刚落地的 `/plm/audit` 从“可看”推进到“可分享、可取证”。

本轮目标有四条：

1. `/plm/audit` 的筛选状态要能同步到 URL
2. 浏览器 `back / forward` 或直接打开显式链接时，要恢复同一组筛选条件
3. 当前筛选结果要支持直接导出 `CSV`
4. 导出和页面列表必须共用同一组后端筛选语义，不能各走各的 where 条件

## 对标基线

上一轮已经交付：

- `/plm/audit`
- `GET /api/plm-workbench/audit-logs`
- `GET /api/plm-workbench/audit-logs/summary`

但还停在“页面内临时状态”阶段：

1. 刷新或分享链接后，筛选条件会丢
2. 没有稳定的导出路径
3. 审计列表和导出若后续各自扩筛选，容易分叉

## 方案

### 1. 抽独立 `audit query state`

新增 [plmAuditQueryState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plmAuditQueryState.ts)，统一管理：

- `auditPage`
- `auditQ`
- `auditActor`
- `auditKind`
- `auditAction`
- `auditType`
- `auditFrom`
- `auditTo`
- `auditWindow`

页面只读写同一份 route state，不再手工拼 query。

### 2. `PlmAuditView` 改为 route-driven

在 [PlmAuditView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmAuditView.vue) 中：

- `watch(route.query)` 作为唯一入口
- `apply filters` / `reset` / `pagination` 统一走 `router.push`
- `summary window` 也进入同一份 query 协议

这样浏览器历史、显式分享链接和页面当前状态是一致的。

### 3. 后端导出复用同一份 where builder

在 [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/plm-workbench.ts) 新增：

- `buildPlmCollaborativeAuditWhere(...)`
- `GET /api/plm-workbench/audit-logs/export.csv`

`list` 与 `export.csv` 共用同一份：

- `q`
- `actorId`
- `action`
- `resourceType`
- `kind`
- `from`
- `to`

避免未来继续扩字段时出现 list/export 不一致。

### 4. 前端 client 补导出 helper

在 [plmWorkbenchClient.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/plm/plmWorkbenchClient.ts) 新增：

- `buildPlmCollaborativeAuditSearch(...)`
- `exportPlmCollaborativeAuditLogsCsv(...)`

这样页面层不需要自己拼 endpoint 或解析 `content-disposition`。

## 超越目标

这轮不只是加了一个“导出按钮”。

真正超过单点修补的点有三条：

1. `/plm/audit` 已有稳定的分享链接协议
2. `list` 与 `export` 已统一成同一份审计筛选模型
3. live/browser 验证可以直接证明“显式 query + CSV 导出”都是基于真实审计数据

## 非目标

本轮不做：

1. 审计页 saved views
2. 审计页服务端分页游标
3. 审计 CSV 异步大文件导出
4. 审计页权限分级

## 验证计划

代码级：

- [plmAuditQueryState.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmAuditQueryState.spec.ts)
- [plmWorkbenchClient.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmWorkbenchClient.spec.ts)
- [plm-workbench-audit-routes.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-workbench-audit-routes.test.ts)
- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-workbench-audit-routes.test.ts`
- `pnpm --filter @metasheet/web exec vitest run tests/plmWorkbenchClient.spec.ts tests/plmAuditQueryState.spec.ts --watch=false`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`

live/browser：

1. 创建临时 `documents team view`
2. 执行批量 `archive / restore / delete`
3. 用 `actorId + action + resourceType + kind + window` 打开显式 `/plm/audit` URL
4. 确认筛选器和表格一起恢复
5. 直调 `export.csv`，确认 CSV 带出当前过滤结果
6. cleanup 后临时协作对象回到 `0`
