# Workflow Hub Team Views 验证记录

日期: 2026-03-09

## 变更范围

- 新增 [workflowHubTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/workflow/workflowHubTeamViews.ts)
- 新增迁移 [zzzz20260309113000_create_workflow_hub_team_views.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/db/migrations/zzzz20260309113000_create_workflow_hub_team_views.ts)
- 更新 [workflow-designer.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/workflow-designer.ts)
- 更新 [AuthService.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/auth/AuthService.ts)
- 新增 [workflow-hub-team-views.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/workflow-hub-team-views.test.ts)
- 更新 [AuthService.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/AuthService.test.ts)
- 更新 [workflowDesignerPersistence.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowDesignerPersistence.ts)
- 更新 [WorkflowHubView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowHubView.vue)
- 更新 [workflowDesignerPersistence.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/workflowDesignerPersistence.spec.ts)
- 使用本轮设计文档 [workflow-hub-team-views-benchmark-design-20260309.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-hub-team-views-benchmark-design-20260309.md)

## 代码级验证

已通过：

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/AuthService.test.ts tests/unit/workflow-hub-team-views.test.ts`
- `pnpm --filter @metasheet/core-backend build`
- `pnpm --filter @metasheet/core-backend migrate`
- `pnpm --filter @metasheet/core-backend exec eslint src/routes/workflow-designer.ts src/workflow/workflowHubTeamViews.ts src/auth/AuthService.ts`
- `pnpm --filter @metasheet/web exec vitest run tests/workflowDesignerPersistence.spec.ts`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

结果：

- `core-backend` 相关单测通过，当前这轮聚焦验证为 `2 files / 8 tests`
- [workflow-hub-team-views.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/workflow-hub-team-views.test.ts) 已覆盖：
  - route state 归一化
  - 存储值构建
  - 行映射与 owner 权限边界
- [AuthService.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/AuthService.test.ts) 已新增非生产 synthetic user fallback 场景
- `apps/web` 当前 `26 files / 103 tests` 通过
- [workflowDesignerPersistence.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/workflowDesignerPersistence.spec.ts) 已覆盖：
  - `team views` 列表归一化
  - `save`
  - `delete`
- `core-backend build`、`apps/web type-check / lint / build`、根级 `pnpm lint` 通过

## 数据库迁移验证

已通过：

- `pnpm --filter @metasheet/core-backend migrate`

结果：

- 新迁移 [zzzz20260309113000_create_workflow_hub_team_views.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/db/migrations/zzzz20260309113000_create_workflow_hub_team_views.ts) 已成功执行
- 迁移输出确认：
  - `migration "zzzz20260309113000_create_workflow_hub_team_views" was executed successfully`

## 上游健康检查

已通过：

- `curl http://127.0.0.1:7910/api/v1/health`

结果：

- 返回 `200`

## Live API 验证

已通过：

- `GET /api/auth/dev-token`
- `GET /api/auth/me`
- `POST /api/workflow-designer/hub-views/team`
- `DELETE /api/workflow-designer/hub-views/team/:id`

结果：

- 经 `7778` 直连验证：
  - `GET /api/auth/me` 返回 `200`
  - `features.workflow = true`
  - `features.mode = plm-workbench`
- 经 `8899` 代理验证：
  - `GET /api/auth/me` 返回 `200`
  - 返回 `dev-user / admin / ["*:*"]`
- team view spot-check 主路径已打通：

```json
{
  "save": {
    "success": true,
    "id": "c20c4d99-e8dc-41ef-99c1-75cd49ee15a7",
    "ownerUserId": "dev-user",
    "canManage": true
  },
  "delete": {
    "success": true,
    "message": "Workflow hub team view deleted successfully"
  }
}
```

关键结论：

- 这轮不是只在源码层增加了接口
- 默认 `dev-token` 下，`save -> delete` 已在 live backend 成功执行
- `8899 -> 7778` 代理链已经能读取到修正后的非生产 synthetic user fallback

## 浏览器 Smoke

本轮 smoke 分成两段：

1. 先验证 `team views` 的 `save -> reload -> apply -> delete`
2. 再验证默认 `dev-token` bootstrap 修正后，空会话直接进入 `/workflows`

证据已归档到：

- [workflow-hub-team-views-20260309](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-hub-team-views-20260309)

关键文件：

- [page-save-success.yml](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-hub-team-views-20260309/page-save-success.yml)
- [page-reload-persisted.yml](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-hub-team-views-20260309/page-reload-persisted.yml)
- [page-delete-success.yml](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-hub-team-views-20260309/page-delete-success.yml)
- [page-default-dev-token.yml](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-hub-team-views-20260309/page-default-dev-token.yml)
- [page-default-dev-token.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-hub-team-views-20260309/page-default-dev-token.png)
- [network-delete-success.log](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-hub-team-views-20260309/network-delete-success.log)

页面结果：

1. 打开 `http://127.0.0.1:8899/workflows`
2. 在 `Template Catalog` 搜索 `parallel`
3. 保存 `Team Parallel Templates`
4. 确认 `Team Views` 卡片出现
5. 刷新或重新进入后，卡片仍存在
6. 点击 `Apply` 后，URL 回到 `?tplSearch=parallel`
7. 点击 `Delete` 后，卡片消失，network 返回 `200`
8. 清空本地 token / session 后重新进入 `/workflows`
9. 默认 `dev-token` bootstrap 已能直接落到 `Workflow Hub`

## 运行时发现与修正

这轮浏览器验证抓到了一个真实 live runtime 问题：

- 默认 `/api/auth/dev-token` 生成的 subject 为 `dev-user`
- `auth/me` 会通过 [AuthService.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/auth/AuthService.ts) 继续回库取用户
- fresh backend 下 `dev-user` 不在库里时，旧逻辑只在 `NODE_ENV=development` 才允许 synthetic fallback
- 当前本地 live backend 运行剖面不是靠这个单一条件保障，因此 `/workflows` 会因为 `Invalid token` 回落

本轮已修正为：

- 非生产环境都允许 synthetic dev user fallback

验证结果：

- `7778` 直连 `auth/me` 返回 `200`
- `8899` 代理 `auth/me` 返回 `200`
- 默认 dev bootstrap 不再阻断 `Workflow Hub`

这次修正不是额外需求，而是 `team views` 能进入 live smoke 的前置条件。

## 验证结论

这轮证明了六件事：

1. `Workflow Hub` 已具备最小可用的后端持久化 `team views`
2. `team views` 现在支持跨刷新、跨新会话仍可读取
3. 同租户成员可见，删除操作保留 owner 边界
4. `apps/web` 与 `core-backend` 的代码级门禁已经覆盖到这轮改动
5. 默认 `dev-token -> auth/me` 已在 live backend 和 `8899` 代理链里恢复可用
6. 浏览器 smoke 已真实走通：
   - `save`
   - `reload`
   - `apply`
   - `delete`
   - 默认 dev bootstrap 直达 `Workflow Hub`

因此，这轮之后 `Workflow Hub` 已从：

- 本地 `saved views`

推进到了：

- 后端持久化 `team views`

如果继续往下做，更自然的下一层已经是：

- team default views
- org-level shared views
- server-side resume
