# PLM Collaborative Audit Query/Export 验证记录

日期: 2026-03-11

## 变更范围

- 更新 [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/plm-workbench.ts)
- 更新 backend 测试 [plm-workbench-audit-routes.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-workbench-audit-routes.test.ts)
- 更新 [plmWorkbenchClient.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/plm/plmWorkbenchClient.ts)
- 更新 web 测试 [plmWorkbenchClient.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmWorkbenchClient.spec.ts)
- 新增 [plmAuditQueryState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plmAuditQueryState.ts)
- 新增 web 测试 [plmAuditQueryState.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmAuditQueryState.spec.ts)
- 更新 [PlmAuditView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmAuditView.vue)
- 使用设计文档 [plm-collaborative-audit-query-export-benchmark-design-20260311.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-collaborative-audit-query-export-benchmark-design-20260311.md)

## 代码级验证

已通过：

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-workbench-audit-routes.test.ts`
- `pnpm --filter @metasheet/core-backend build`
- `pnpm --filter @metasheet/web exec vitest run tests/plmWorkbenchClient.spec.ts tests/plmAuditQueryState.spec.ts --watch=false`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

结果：

- backend audit route tests 通过，当前 `1 file / 3 tests`
- web focused tests 通过，当前 `2 files / 19 tests`
- `apps/web` package 级测试通过，当前 `32 files / 165 tests`
- `type-check / lint / build` 全部通过

## 聚焦覆盖点

本轮重点锁住的是：

1. `audit query state` 的 parse/build/equality
2. `export.csv` 使用与 `list` 一致的过滤语义
3. `PlmAuditView` 的导出 client 会正确读取 `content-disposition`
4. `/plm/audit` 显式 query 打开后，筛选器与表格会一起恢复

## Live API 验证

setup/export artifact：

- [plm-collaborative-audit-query-export-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-collaborative-audit-query-export-20260311.json)

本轮创建了一条临时 `documents team view`：

- `61cb39e3-99c5-49fd-9ff4-d9289e39a73b`

随后执行：

- `archive`
- `restore`
- `delete`

并使用以下过滤条件查询：

- `actorId=dev-user`
- `action=archive`
- `resourceType=plm-team-view-batch`
- `kind=documents`
- `from=<archive time - 5m>`
- `to=<archive time + 5m>`

live 结果确认：

- `filteredList.data.total = 2`
- `filteredList.data.items[0].action = archive`
- `filteredList.data.items[0].resourceType = plm-team-view-batch`
- `filteredList.data.items[0].meta.processedKinds = ['documents']`
- `export.csv` 返回 `200`
- CSV preview 包含：
  - header
  - 至少 2 条 `documents archive` 行

## Browser Smoke 验证

浏览器使用显式 URL 打开：

- `http://127.0.0.1:8899/plm/audit?auditActor=dev-user&auditKind=documents&auditAction=archive&auditType=plm-team-view-batch&auditWindow=720`

页面结果确认：

- 标题：
  - `PLM Audit - MetaSheet`
- 顶部 summary：
  - `窗口 720 分钟`
  - `资源桶 12`
  - `主要动作 归档`
- 筛选器已自动恢复：
  - `操作者 = dev-user`
  - `类型 = Documents`
  - `动作 = 归档`
  - `资源 = 团队视图批量`
  - `窗口 = 720 分钟`
- 状态提示：
  - `已加载 3 条审计日志。`
- 表格 3 行均为：
  - `团队视图批量`
  - `documents`
  - `归档`
  - `dev-user`

browser 证据：

- [plm-collaborative-audit-query-export-browser-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-collaborative-audit-query-export-browser-20260311.json)
- [page-plm-collaborative-audit-query-export.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-collaborative-audit-query-export-20260311/page-plm-collaborative-audit-query-export.png)
- [page-plm-collaborative-audit-query-export.txt](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-collaborative-audit-query-export-20260311/page-plm-collaborative-audit-query-export.txt)

## 验证结论

本轮已经确认：

1. `/plm/audit` 的筛选状态已可稳定分享和回放
2. `list` 与 `export.csv` 共用同一份审计过滤模型
3. 页面已经从“可看”推进到“可取证”
4. 当前实现足以支撑下一步继续做审计页 saved views 或更细的协作审计中心

## Live Cleanup 验证

cleanup artifact：

- [plm-collaborative-audit-query-export-cleanup-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-collaborative-audit-query-export-cleanup-20260311.json)

结果：

- 临时 `documents team view` 已不存在
- `remainingCount = 0`
- 不需要额外清理
