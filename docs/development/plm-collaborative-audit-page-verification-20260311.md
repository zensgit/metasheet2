# PLM Collaborative Audit Page 验证记录

日期: 2026-03-11

## 变更范围

- 更新 [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/plm-workbench.ts)
- 新增 backend 测试 [plm-workbench-audit-routes.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-workbench-audit-routes.test.ts)
- 更新 backend 测试 [plm-workbench-routes.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-workbench-routes.test.ts)
- 更新 [plmWorkbenchClient.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/plm/plmWorkbenchClient.ts)
- 更新 web 测试 [plmWorkbenchClient.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmWorkbenchClient.spec.ts)
- 新增 [PlmAuditView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmAuditView.vue)
- 更新 [main.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/main.ts)
- 更新 [App.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/App.vue)
- 使用设计文档 [plm-collaborative-audit-page-benchmark-design-20260311.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-collaborative-audit-page-benchmark-design-20260311.md)

## 代码级验证

已通过：

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-workbench-routes.test.ts tests/unit/plm-workbench-audit-routes.test.ts`
- `pnpm --filter @metasheet/core-backend build`
- `pnpm --filter @metasheet/web exec vitest run tests/plmWorkbenchClient.spec.ts --watch=false`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

结果：

- backend tests 通过，当前 `2 files / 28 tests`
- web focused client tests 通过，当前 `1 file / 15 tests`
- `apps/web` package 级测试通过，当前 `31 files / 161 tests`
- `type-check / lint / build` 全部通过

## 聚焦覆盖点

本轮重点锁住的是：

1. 批量 `team preset` 动作会真正写入 `operation_audit_logs`
2. 批量 `team view` 动作会真正写入 `operation_audit_logs`
3. `/api/plm-workbench/audit-logs` 能把 `meta` 正规化成前端可展示结构
4. `/api/plm-workbench/audit-logs/summary` 能聚合出 action/resource 桶
5. `/plm/audit` 能读取真实 live 数据，而不是只显示空状态

## Live API 准备

setup artifact:

- [plm-collaborative-audit-page-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-collaborative-audit-page-20260311.json)

本轮创建了两条临时对象：

1. `BOM team preset`
   - id: `2cbdbb82-192c-433e-a8a4-7a26f77b10cf`
2. `documents team view`
   - id: `eacfba01-f116-4f76-91c6-919ccbda93f7`

并依次执行：

- `archive`
- `restore`
- `delete`

随后实时查询：

- `GET /api/plm-workbench/audit-logs?page=1&pageSize=8`
- `GET /api/plm-workbench/audit-logs/summary?windowMinutes=180&limit=8`

live 返回结果确认：

- `auditList.data.items.length = 6`
- `summary.actions = archive:2 / delete:2 / restore:2`
- `summary.resourceTypes = plm-team-preset-batch:3 / plm-team-view-batch:3`

## Browser Smoke 验证

浏览器已真实打开：

- `http://127.0.0.1:8899/plm/audit`

页面标题：

- `PLM Audit - MetaSheet`

页面关键信息：

- 顶部 summary cards:
  - `窗口 180 分钟`
  - `资源桶 6`
  - `主要动作 归档`
- action pills:
  - `归档 · 2`
  - `删除 · 2`
  - `恢复 · 2`
- resource pills:
  - `团队预设批量 · 3`
  - `团队视图批量 · 3`
- 状态提示：
  - `已加载 6 条审计日志。`

表格明细共 6 行：

1. `团队视图批量 / documents / 删除`
2. `团队视图批量 / documents / 恢复`
3. `团队视图批量 / documents / 归档`
4. `团队预设批量 / bom / 删除`
5. `团队预设批量 / bom / 恢复`
6. `团队预设批量 / bom / 归档`

每条记录展开后都能看到：

- `tenantId`
- `ownerUserId`
- `requestedIds`
- `processedIds`
- `skippedIds`
- `processedKinds`
- `requestedTotal`
- `processedTotal`
- `skippedTotal`

browser 证据：

- [plm-collaborative-audit-page-browser-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-collaborative-audit-page-browser-20260311.json)
- [page-plm-collaborative-audit.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-collaborative-audit-page-20260311/page-plm-collaborative-audit.png)
- [page-plm-collaborative-audit.txt](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-collaborative-audit-page-20260311/page-plm-collaborative-audit.txt)

## 修正点

本轮 live 验证抓到一个真实问题：

- 初版批量审计写入复用了 `audit.ts` 的路径
- 但这条链会落到 `audit_logs`
- `/plm/audit` 查询的是 `operation_audit_logs`

修正后：

- 批量审计改为直接写 `operation_audit_logs`
- list/summary 页面立即能读到真实数据

## 验证结论

本轮已经确认：

1. `PLM collaborative batch audit` 已有稳定后端查询接口
2. `/plm/audit` 已成为正式工作台页，不是临时调试页
3. `team preset` 与 `team view` 的批量动作已统一纳入同一审计域
4. 页面 summary 与表格明细都来自真实 live 批量动作
5. 当前实现足以支撑后续继续做批量审计汇总或协作审计中心

## Live Cleanup 验证

cleanup artifact:

- [plm-collaborative-audit-page-cleanup-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-collaborative-audit-page-cleanup-20260311.json)

结果：

- 临时 `BOM team preset` 已不存在
- 临时 `documents team view` 已不存在
- 不需要额外二次清理
