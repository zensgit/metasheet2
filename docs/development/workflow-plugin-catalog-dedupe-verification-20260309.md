# Workflow Plugin Catalog Dedupe 验证记录

日期: 2026-03-09

## 变更范围

- 更新 [App.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/App.vue)
- 使用已更新的 [featureFlags.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/stores/featureFlags.ts)
- 使用本轮新增设计文档 [workflow-plugin-catalog-dedupe-benchmark-design-20260309.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-plugin-catalog-dedupe-benchmark-design-20260309.md)

## 代码级验证

已通过：

- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

结果：

- `apps/web` 当前 `22 files / 86 tests` 通过
- `apps/web type-check / lint / build` 通过
- 根级 `pnpm lint` 通过

## 上游健康检查

已通过：

- `curl http://127.0.0.1:7910/api/v1/health`

结果：

- 返回 `200`

这证明本轮 live smoke 使用的 `plm-workbench / workflow` 联动环境仍然有效。

## 浏览器 Smoke

使用 Playwright CLI 隔离会话：

- `open http://127.0.0.1:8899/workflows --isolated`
- `network`
- `snapshot`
- `screenshot`

关键证据已归档到：

- [workflow-plugin-catalog-dedupe-20260309](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-plugin-catalog-dedupe-20260309)

关键文件：

- [network-2026-03-09T02-08-21-578Z.log](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-plugin-catalog-dedupe-20260309/network-2026-03-09T02-08-21-578Z.log)
- [page-2026-03-09T02-08-22-286Z.yml](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-plugin-catalog-dedupe-20260309/page-2026-03-09T02-08-22-286Z.yml)
- [page-2026-03-09T02-08-21-698Z.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-plugin-catalog-dedupe-20260309/page-2026-03-09T02-08-21-698Z.png)

页面结果：

- URL: `http://127.0.0.1:8899/workflows`
- Title: `Workflows - MetaSheet`
- 品牌: `PLM 工作台`
- 主体: `Workflow Hub`
- 模板目录正常显示 builtin 模板

关键 snapshot 结果：

- 导航仍显示：
  - `PLM`
  - `流程`
  - `审批中心`
- 页面主体仍显示：
  - `Workflow Drafts`
  - `Template Catalog`
  - `Simple Approval Workflow`
  - `Parallel Review Workflow`

## Network 结果

关键 network log 为：

- [network-2026-03-09T02-08-21-578Z.log](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-plugin-catalog-dedupe-20260309/network-2026-03-09T02-08-21-578Z.log)

请求结果：

- `GET /api/auth/me` -> `200`
- `GET /api/workflow-designer/workflows?...` -> `200`
- `GET /api/workflow-designer/templates?...` -> `200`

关键结论：

- 本轮 smoke 中 **没有出现** `/api/plugins`

这说明 `workflow/plm-workbench` 启动链里，之前残余的那一次插件目录请求已经被收掉。

## 对比上一轮

上一轮 live runtime 验证见：

- [workflow-live-dev-runtime-alignment-verification-20260309.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-live-dev-runtime-alignment-verification-20260309.md)

当时 network 结果是：

- `GET /api/plugins` -> `200`
- `GET /api/auth/me` -> `200`
- `GET /api/workflow-designer/workflows?...` -> `200`
- `GET /api/workflow-designer/templates?...` -> `200`

这次已经收敛成：

- `GET /api/auth/me` -> `200`
- `GET /api/workflow-designer/workflows?...` -> `200`
- `GET /api/workflow-designer/templates?...` -> `200`

也就是：

- `/api/plugins`: `1 -> 0`

## 验证结论

这轮证明了四件事：

1. [App.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/App.vue) 的启动顺序修正没有破坏 `/workflows` 首屏
2. `plm-workbench` 壳下的 `Workflow Hub` 仍能正常渲染
3. 残余的 `/api/plugins` 请求已经从 live 启动链里消失
4. `workflow/plm-workbench` 的首屏初始化进一步收敛成“只加载当前页面需要的数据”

因此，这轮之后 `workflow hub` 这条线的下一类优化点已经不是“再去重插件请求”，而是：

- 如果未来还要继续优化，就应该转向：
  - shared catalog cache
  - workflow hub 性能与交互
  - 或者回到 `PLM` 第二阶段功能深化
