# Workflow Hub Saved Views 验证记录

日期: 2026-03-09

## 变更范围

- 新增 [workflowHubSavedViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowHubSavedViews.ts)
- 更新 [WorkflowHubView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowHubView.vue)
- 新增 [workflowHubSavedViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/workflowHubSavedViews.spec.ts)
- 使用本轮新增设计文档 [workflow-hub-saved-views-benchmark-design-20260309.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-hub-saved-views-benchmark-design-20260309.md)

## 代码级验证

已通过：

- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

结果：

- `apps/web` 当前 `25 files / 96 tests` 通过
- 新增的 [workflowHubSavedViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/workflowHubSavedViews.spec.ts) 已覆盖：
  - 保存多个 named views
  - 同名大小写归一更新
  - 删除 saved view
- 本轮修正了 saved view ID 生成逻辑，避免 `Date.now()` 在同毫秒内冲突，导致新视图覆盖旧视图
- `apps/web type-check / lint / build` 通过
- 根级 `pnpm lint` 通过

## 上游健康检查

已通过：

- `curl http://127.0.0.1:7910/api/v1/health`

结果：

- 返回 `200`

## 浏览器 Smoke

本轮 smoke 重点验证 `save / apply / delete` 的完整主路径，而不是只看页面是否加载：

1. 打开 `http://127.0.0.1:8899/workflows`
2. 在 `Template Catalog` 搜索框输入 `parallel`
3. 点击 `Apply`
4. 点击 `Save view`
5. 输入 `Parallel Templates Saved`
6. 清空模板搜索并重新 `Apply`
7. 点击 `Apply view`
8. 点击 `Delete` 并确认删除

证据已归档到：

- [workflow-hub-saved-views-20260309](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-hub-saved-views-20260309)

关键文件：

- [page-2026-03-09T03-08-40-351Z.yml](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-hub-saved-views-20260309/page-2026-03-09T03-08-40-351Z.yml)
- [page-2026-03-09T03-08-55-264Z.yml](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-hub-saved-views-20260309/page-2026-03-09T03-08-55-264Z.yml)
- [page-2026-03-09T03-09-12-774Z.yml](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-hub-saved-views-20260309/page-2026-03-09T03-09-12-774Z.yml)
- [page-2026-03-09T03-09-28-542Z.yml](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-hub-saved-views-20260309/page-2026-03-09T03-09-28-542Z.yml)
- [page-2026-03-09T03-09-38-617Z.yml](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-hub-saved-views-20260309/page-2026-03-09T03-09-38-617Z.yml)
- [page-2026-03-09T03-09-45-638Z.yml](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-hub-saved-views-20260309/page-2026-03-09T03-09-45-638Z.yml)
- [page-2026-03-09T03-09-53-970Z.yml](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-hub-saved-views-20260309/page-2026-03-09T03-09-53-970Z.yml)
- [page-2026-03-09T03-10-00-357Z.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-hub-saved-views-20260309/page-2026-03-09T03-10-00-357Z.png)

页面结果：

- 搜索 `parallel` 后，URL 变为 `http://127.0.0.1:8899/workflows?tplSearch=parallel`
- `Save view` 会弹出命名对话框，输入 `Parallel Templates Saved` 后保存成功
- `Saved Views` 区块会展示：
  - 名称 `Parallel Templates Saved`
  - 摘要 `TPL:parallel`
  - 动作 `Apply view / Delete`
- 清空搜索重新 `Apply` 后，`Template Catalog` 从 `1` 条回到 `2` 条
- 点击 `Apply view` 后，URL 恢复为 `?tplSearch=parallel`
- `Template Catalog` 再次收敛到 `Parallel Review Workflow`
- 点击 `Delete` 并确认后，saved view 卡片消失，并出现 `视图已删除` 提示

## 验证结论

这轮证明了五件事：

1. `Workflow Hub` 已具备最小可用的 named saved views
2. saved view 保存的是完整 route state，而不是单个搜索词
3. `Apply view` 已能真实恢复当前工作视角
4. `Delete` 已具备确认和清理语义
5. saved views 这层现在已经可以承接后续的：
   - shared views
   - default team views
   - recent filters

因此，这轮之后如果继续优化 `Workflow Hub`，更自然的方向已经是：

- saved views 的共享化
- back/forward 历史回放
- workflow/template 双面板默认视角策略
