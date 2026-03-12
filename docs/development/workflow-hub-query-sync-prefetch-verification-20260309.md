# Workflow Hub Query Sync / Prefetch 验证记录

日期: 2026-03-09

## 变更范围

- 新增 [workflowHubQueryState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowHubQueryState.ts)
- 更新 [WorkflowHubView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowHubView.vue)
- 更新 [apps/web/package.json](/Users/huazhou/Downloads/Github/metasheet2/apps/web/package.json)
- 新增 [workflowHubQueryState.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/workflowHubQueryState.spec.ts)
- 使用本轮新增设计文档 [workflow-hub-query-sync-prefetch-benchmark-design-20260309.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-hub-query-sync-prefetch-benchmark-design-20260309.md)

## 代码级验证

已通过：

- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

结果：

- `apps/web` 当前 `24 files / 93 tests` 通过
- 新增的 [workflowHubQueryState.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/workflowHubQueryState.spec.ts) 已覆盖：
  - route parse
  - shareable query build
  - next offset 计算
- `apps/web type-check / lint / build` 通过
- 根级 `pnpm lint` 通过

## 上游健康检查

已通过：

- `curl http://127.0.0.1:7910/api/v1/health`

结果：

- 返回 `200`

## 浏览器 Smoke

本轮 smoke 重点不是 designer，而是验证 `Workflow Hub` 自己的 query 交互：

1. 打开 `http://127.0.0.1:8899/workflows`
2. 在 `Template Catalog` 搜索框输入 `parallel`
3. 点击 `Apply`
4. 采集 URL / snapshot / screenshot / network log

证据已归档到：

- [workflow-hub-query-sync-20260309](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-hub-query-sync-20260309)

关键文件：

- [network-2026-03-09T03-01-38-760Z.log](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-hub-query-sync-20260309/network-2026-03-09T03-01-38-760Z.log)
- [page-2026-03-09T03-01-30-986Z.yml](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-hub-query-sync-20260309/page-2026-03-09T03-01-30-986Z.yml)
- [page-2026-03-09T03-01-39-940Z.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-hub-query-sync-20260309/page-2026-03-09T03-01-39-940Z.png)

页面结果：

- 页面 URL 已变为 `http://127.0.0.1:8899/workflows?tplSearch=parallel`
- `Template Catalog` 数量从 `2` 收敛到 `1`
- 页面仅保留 `Parallel Review Workflow`
- 搜索框内值保持为 `parallel`

## Network 结果

关键 network log 为：

- [network-2026-03-09T03-01-38-760Z.log](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-hub-query-sync-20260309/network-2026-03-09T03-01-38-760Z.log)

请求结果：

- `GET /api/auth/me` -> `200`
- `GET /api/workflow-designer/workflows?sortBy=updated_at&sortOrder=desc&limit=8&offset=0` -> `200`
- `GET /api/workflow-designer/templates?source=all&sortBy=usage_count&sortOrder=desc&limit=6&offset=0` -> `200`
- `GET /api/workflow-designer/templates?search=parallel&source=all&sortBy=usage_count&sortOrder=desc&limit=6&offset=0` -> `200`

关键结论：

- `Apply` 后 URL 已同步 `tplSearch=parallel`
- 网络请求也已经按 query 变化
- 页面结果与 query 保持一致

这证明 `Workflow Hub` 的筛选状态已经不再只是内存态，而开始成为 shareable route state。

## 验证结论

这轮证明了四件事：

1. `Workflow Hub` 已具备 URL query 同步能力
2. `Apply` 已回第一页并重算目录结果
3. 页面结果、URL、网络请求三者已经一致
4. 下一页预取和前一轮 catalog cache 已有可继续放大的基础

因此，这轮之后如果继续优化 `Workflow Hub`，更自然的方向已经是：

- saved filters / saved views
- browser history 回放
- 或更强的分页预取与骨架屏体验
