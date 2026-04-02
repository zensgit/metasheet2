# Workflow Hub History Replay 验证记录

日期: 2026-03-09

## 变更范围

- 更新 [workflowHubQueryState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowHubQueryState.ts)
- 更新 [WorkflowHubView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowHubView.vue)
- 更新 [workflowHubQueryState.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/workflowHubQueryState.spec.ts)
- 使用本轮新增设计文档 [workflow-hub-history-replay-benchmark-design-20260309.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-hub-history-replay-benchmark-design-20260309.md)

## 代码级验证

已通过：

- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

结果：

- `apps/web` 当前 `25 files / 97 tests` 通过
- [workflowHubQueryState.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/workflowHubQueryState.spec.ts) 已新增 route state equality 覆盖
- `WorkflowHubView.vue` 已改为在 `route.query` 变化时执行 `parse -> compare -> apply -> refresh`
- `apps/web type-check / lint / build` 通过
- 根级 `pnpm lint` 通过

## 上游健康检查

已通过：

- `curl http://127.0.0.1:7910/api/v1/health`

结果：

- 返回 `200`

## 浏览器 Smoke

本轮 smoke 重点不是保存视图，而是验证浏览器 `back / forward` 的真实回放：

1. 打开 `http://127.0.0.1:8899/workflows`
2. 在 `Template Catalog` 搜索 `parallel`
3. 点击 `Apply`
4. 改为搜索 `simple`
5. 点击 `Apply`
6. 浏览器 `Back`
7. 浏览器 `Forward`

证据已归档到：

- [workflow-hub-history-replay-20260309](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-hub-history-replay-20260309)

关键文件：

- [page-2026-03-09T03-25-04-502Z.yml](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-hub-history-replay-20260309/page-2026-03-09T03-25-04-502Z.yml)
- [page-2026-03-09T03-25-16-776Z.yml](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-hub-history-replay-20260309/page-2026-03-09T03-25-16-776Z.yml)
- [page-2026-03-09T03-25-22-556Z.yml](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-hub-history-replay-20260309/page-2026-03-09T03-25-22-556Z.yml)
- [page-2026-03-09T03-25-31-239Z.yml](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-hub-history-replay-20260309/page-2026-03-09T03-25-31-239Z.yml)
- [network-2026-03-09T03-25-44-333Z.log](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-hub-history-replay-20260309/network-2026-03-09T03-25-44-333Z.log)
- [page-2026-03-09T03-25-49-734Z.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-hub-history-replay-20260309/page-2026-03-09T03-25-49-734Z.png)

页面结果：

- 第一次 `Apply` 后，URL 为 `?tplSearch=parallel`，页面只保留 `Parallel Review Workflow`
- 第二次 `Apply` 后，URL 为 `?tplSearch=simple`，页面只保留 `Simple Approval Workflow`
- 浏览器 `Back` 后：
  - URL 回到 `?tplSearch=parallel`
  - 搜索框值回到 `parallel`
  - 页面结果回到 `Parallel Review Workflow`
- 浏览器 `Forward` 后：
  - URL 回到 `?tplSearch=simple`
  - 搜索框值回到 `simple`
  - 页面结果回到 `Simple Approval Workflow`

## Network 结果

关键 network log 为：

- [network-2026-03-09T03-25-44-333Z.log](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-hub-history-replay-20260309/network-2026-03-09T03-25-44-333Z.log)

请求结果：

- `GET /api/workflow-designer/templates?search=parallel...` -> `200`
- `GET /api/workflow-designer/templates?search=simple...` -> `200`
- 浏览器 `Back` 后再次请求 `search=parallel` -> `200`
- 浏览器 `Forward` 后再次请求 `search=simple` -> `200`

关键结论：

- 浏览器 history 已不只是地址栏变化
- route query 变化后，页面状态和目录请求都会回放

## 验证结论

这轮证明了四件事：

1. `Workflow Hub` 已具备真实浏览器 `back / forward` 状态回放
2. route query、页面输入状态、目录数据结果三者已经联动
3. 这层 replay 能与前几轮的 `query sync / saved views / shared cache` 正常协同
4. `Workflow Hub` 现在已经具备继续演进到：
   - shared views
   - session restore
   - route-driven entry presets

因此，这轮之后如果继续优化 `Workflow Hub`，更自然的方向已经是：

- shared team views
- session restore
- route-driven onboarding
