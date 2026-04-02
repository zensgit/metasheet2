# Workflow Live Dev Runtime Alignment 验证记录

日期: 2026-03-09

## 变更范围

- 运行态重启 [@metasheet/core-backend](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/package.json)
- 使用已更新的 [App.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/App.vue)
- 使用已更新的 [HomeRedirect.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/HomeRedirect.vue)
- 使用已更新的 [auth.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/auth.ts)
- 使用本轮新增设计文档 [workflow-live-dev-runtime-alignment-benchmark-design-20260309.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-live-dev-runtime-alignment-benchmark-design-20260309.md)

## 运行时剖面

本轮 live backend 使用以下环境启动：

- `DATABASE_URL=postgresql://metasheet:metasheet123@localhost:5432/metasheet_v2`
- `PORT=7778`
- `NODE_ENV=development`
- `WORKFLOW_ENABLED=true`
- `PRODUCT_MODE=plm-workbench`

启动命令：

- `DATABASE_URL=... PORT=7778 NODE_ENV=development WORKFLOW_ENABLED=true PRODUCT_MODE=plm-workbench pnpm --filter @metasheet/core-backend dev:core`

结果：

- backend 成功监听 `http://localhost:7778`
- 日志确认：
  - `MetaSheet v2 core listening on http://localhost:7778`
  - `Loaded 2 workflow templates`
  - `workflow.started / workflow.completed / workflow.failed` 事件类型已注册

## 代码级验证

已通过：

- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm --filter @metasheet/core-backend build`
- `pnpm --filter @metasheet/core-backend exec eslint src/routes/auth.ts`
- `pnpm lint`

结果：

- `apps/web` 当前 `22 files / 85 tests` 通过
- `apps/web type-check / lint / build` 通过
- `core-backend build` 通过
- targeted eslint 通过
- 根级 `pnpm lint` 通过

## Live API 验证

已通过：

- `curl http://127.0.0.1:8899/api/auth/dev-token`
- `curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8899/api/auth/me`
- `curl http://127.0.0.1:8899/api/plugins`

结果：

- `dev-token` 返回 `200`
- `auth/me` 返回 `200`
- `plugins` 返回 `200`

关键结果：

```json
{
  "features": {
    "attendance": true,
    "workflow": true,
    "attendanceAdmin": true,
    "attendanceImport": true,
    "mode": "plm-workbench"
  }
}
```

这证明本轮修正已经在 `8899 -> 7778` 的 live 代理链里生效，不再只是源码层结论。

## 浏览器 Smoke

使用 Playwright CLI 独立隔离会话：

- `open http://127.0.0.1:8899/workflows --isolated`
- `network`
- `snapshot`
- `screenshot`

结果：

- 页面 URL: `http://127.0.0.1:8899/workflows`
- 页面标题: `Workflows - MetaSheet`
- 导航品牌已切为 `PLM 工作台`
- workflow 主体已渲染 `Workflow Hub`
- 模板目录已显示 builtin 模板条目

关键 snapshot 证据：

- [page-2026-03-09T01-47-55-789Z.yml](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-live-auth-bootstrap-20260309/page-2026-03-09T01-47-55-789Z.yml)
- [page-2026-03-09T01-48-24-709Z.yml](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-live-auth-bootstrap-20260309/page-2026-03-09T01-48-24-709Z.yml)
- [page-2026-03-09T01-48-09-444Z.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-live-auth-bootstrap-20260309/page-2026-03-09T01-48-09-444Z.png)

关键 network 证据：

- [network-2026-03-09T01-48-09-351Z.log](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-live-auth-bootstrap-20260309/network-2026-03-09T01-48-09-351Z.log)

network 结果：

- `GET /api/plugins` -> `200`
- `GET /api/plugins` -> `200`
- `GET /api/auth/dev-token` -> `200`
- `GET /api/auth/me` -> `200`
- `GET /api/workflow-designer/workflows?...` -> `200`
- `GET /api/workflow-designer/templates?...` -> `200`

## 关键结论

### 1. `/workflows` 已不再回落

在新的 live backend 剖面下，浏览器进入 `/workflows` 后：

- 没有再被回退到 `/grid`
- 没有再被回退到 `/plm`
- 页面主体验证为 `Workflow Hub`

### 2. `dev-token -> auth/me` 已在 live 代理链打通

此前这条链只在源码级能解释，现在已经通过 `8899` 代理验证成功。

### 3. `plm-workbench` 模式已真实生效

不仅是 `/api/auth/me` payload 里返回 `mode: plm-workbench`，浏览器导航品牌也已经切成 `PLM 工作台`，说明 mode 已开始影响真实 UI。

## 剩余尾项

### 初始化阶段仍有两次 `/api/plugins`

本轮 smoke 里仍看到：

- `GET /api/plugins`
- `GET /api/plugins`

这说明重复请求的剩余尾项已经从：

- `dev-token / auth/me / plugins`

收窄成：

- `plugins / plugins`

更具体地说，`featureFlags` 的 plugin inference 和 [App.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/App.vue) 的 `fetchPlugins()` 仍在并行触发。

这已经不阻断 workflow hub，但它是下一步最自然的优化点。

## 验证结论

这轮证明了五件事：

1. 新 backend 源码已经真正进入 live dev 运行态
2. `dev-token -> auth/me` 已在 `8899` 代理链里返回 `200`
3. `workflow=true` 与 `mode=plm-workbench` 已真实驱动 `/workflows` 页面直达
4. 浏览器里 `Workflow Hub` 已可见，不再只是接口存在
5. 剩余初始化噪声已经被缩小并精确定位到重复 `/api/plugins`

因此，这轮之后 workflow 这条线的下一个优化点已经很清楚：

不是继续修 auth/bootstrap，而是去重 `plugins` 初始化请求。 
