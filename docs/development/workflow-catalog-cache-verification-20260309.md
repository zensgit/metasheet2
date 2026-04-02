# Workflow Catalog Cache 验证记录

日期: 2026-03-09

## 变更范围

- 新增 [workflowDesignerCatalogCache.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowDesignerCatalogCache.ts)
- 更新 [WorkflowHubView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowHubView.vue)
- 更新 [WorkflowDesigner.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowDesigner.vue)
- 新增 [workflowDesignerCatalogCache.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/workflowDesignerCatalogCache.spec.ts)
- 使用本轮新增设计文档 [workflow-catalog-cache-benchmark-design-20260309.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-catalog-cache-benchmark-design-20260309.md)

## 代码级验证

已通过：

- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

结果：

- `apps/web` 当前 `23 files / 90 tests` 通过
- 新增的 [workflowDesignerCatalogCache.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/workflowDesignerCatalogCache.spec.ts) 已覆盖：
  - identical query reuse
  - draft cache invalidation
  - template detail invalidation
  - forced reload
- `apps/web type-check / lint / build` 通过
- 根级 `pnpm lint` 通过

## 上游健康检查

已通过：

- `curl http://127.0.0.1:7910/api/v1/health`

结果：

- 返回 `200`

## 浏览器 Smoke

本轮 smoke 不是只看 `/workflows` 首屏，而是验证跨页复用路径：

1. 打开 `http://127.0.0.1:8899/workflows`
2. 点击 `New workflow`
3. 进入 `/workflows/designer`
4. 打开 `模板` 弹窗
5. 采集 network / snapshot / screenshot

证据已归档到：

- [workflow-catalog-cache-20260309](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-catalog-cache-20260309)

关键文件：

- [network-2026-03-09T02-19-13-236Z.log](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-catalog-cache-20260309/network-2026-03-09T02-19-13-236Z.log)
- [page-2026-03-09T02-19-06-981Z.yml](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-catalog-cache-20260309/page-2026-03-09T02-19-06-981Z.yml)
- [page-2026-03-09T02-19-13-182Z.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-catalog-cache-20260309/page-2026-03-09T02-19-13-182Z.png)

页面结果：

- `Workflow Hub` 仍正常加载
- 点击 `New workflow` 后成功进入 `Workflow Designer`
- 模板弹窗可正常打开
- 模板列表和模板详情都正常显示

## Network 结果

关键 network log 为：

- [network-2026-03-09T02-19-13-236Z.log](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-catalog-cache-20260309/network-2026-03-09T02-19-13-236Z.log)

请求结果：

- `GET /api/auth/me` -> `200`
- `GET /api/workflow-designer/workflows?...` -> `200`
- `GET /api/workflow-designer/templates?source=all&sortBy=usage_count&sortOrder=desc&limit=6&offset=0` -> `200`
- `GET /api/workflow-designer/templates/simple-approval` -> `200`

关键结论：

- `Hub -> Designer -> 模板弹窗` 这条链里，模板目录列表只请求了 **1 次**
- 打开模板弹窗后只新增了 **template detail** 请求，没有再次拉取 template list

也就是：

- `template list`: `2 -> 1`

这证明共享 catalog cache 已经从单页收益推进到了跨页收益。

## 残余观察

本轮浏览器 smoke 里仍有一条非阻塞 console 观察：

- `unsupported configuration <keyboard.bindTo...>` 来自 `bpmn-js`

页面功能未受阻断：

- Designer 成功加载
- 模板弹窗可用
- 目录缓存行为符合预期

因此这条被记录为后续 runtime polish 项，不作为本轮失败判据。

## 验证结论

这轮证明了五件事：

1. `workflow drafts / template catalog / template detail` 已提升成共享前端 cache
2. `Workflow Hub` 与 `Workflow Designer` 已开始复用同一套 catalog source
3. `Refresh` 与 mutation invalidation 仍能保持目录正确性
4. `Hub -> Designer -> 模板弹窗` 已减少重复目录请求
5. 这条收益已经不是“页面内去重”，而是“跨页路径去重”

因此，这轮之后如果继续优化 `workflow hub`，更自然的方向已经是：

- catalog background refresh
- list/search 交互优化
- 或 `template detail` 的进一步预取策略
