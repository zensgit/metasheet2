# Workflow Dev Auth Bootstrap 验证记录

日期: 2026-03-09

## 变更范围

- 更新 [App.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/App.vue)
- 更新 [HomeRedirect.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/HomeRedirect.vue)
- 更新 [auth.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/auth.ts)
- 更新 [apps/web/package.json](/Users/huazhou/Downloads/Github/metasheet2/apps/web/package.json)

## 本轮结果

### 1. 前端重复 feature bootstrap 已收敛

本轮把以下两处重复调用移除：

- [App.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/App.vue) `onMounted() -> loadProductFeatures()`
- [HomeRedirect.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/HomeRedirect.vue) `onMounted() -> loadProductFeatures()`

结果：

- `loadProductFeatures()` 现在由 [main.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/main.ts) 的 route guard 主导
- `App.vue` 只负责导航级插件装配
- `HomeRedirect.vue` 只负责按已解析的 mode 做首页跳转

这让 clean session 下的 `dev-token / auth/me` 请求链少了两条显式重复入口。

### 2. workflow nav 已和 feature gate 对齐

[App.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/App.vue) 中 `/workflows` 导航现在受 `hasFeature('workflow')` 控制。

结果：

- 当 backend 明确返回 `workflow: false` 时，导航不再暴露 workflow 入口
- 导航层和 [main.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/main.ts) 的 `requiredFeature: 'workflow'` 保持一致

### 3. backend `/api/auth/me` 已支持 `plm-workbench`

[auth.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/auth.ts) 的 product mode 归一化已扩展为：

- `attendance / attendance-focused -> attendance`
- `plm-workbench / plmWorkbench / plm-focused -> plm-workbench`
- 其他 -> `platform`

结果：

- 前端 [featureFlags.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/stores/featureFlags.ts) 已支持的 `plm-workbench` 模式，现在终于能从 backend 原生返回
- workflow / PLM workbench 的首页落点不再必然回落到 `platform`

### 4. `dev-token` 的 secret 语义已与 `AuthService` 对齐

[auth.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/auth.ts) 的 `/api/auth/dev-token` 已改为通过 `SecretManager` 读取 `JWT_SECRET`，不再只依赖 `process.env.JWT_SECRET`。

结果：

- `SECRET_PROVIDER=file` 等场景下，`/dev-token` 和 [AuthService.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/auth/AuthService.ts) 终于共享同一套 secret 语义
- 源码级验证已证明：按 `/dev-token` 同样的 claim 与 secret 生成 token，`AuthService.verifyToken()` 可以成功验过

## 验证命令

已通过：

- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm --filter @metasheet/core-backend build`
- `pnpm --filter @metasheet/core-backend exec eslint src/routes/auth.ts`
- `pnpm lint`
- `NODE_ENV=development pnpm --filter @metasheet/core-backend exec tsx --eval "... authService.verifyToken(token) ..."`

结果：

- `apps/web` 当前 `22 files / 85 tests` 通过
- `apps/web type-check / lint / build` 通过
- `core-backend build` 通过
- `auth.ts` 的 targeted eslint 通过
- 根级 `pnpm lint` 通过
- 源码级 dev-token 验证输出：
  - `{"ok":true,"id":"dev-user","role":"admin","permissions":["*:*"]}`

## 运行时补充检查

已通过：

- `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8899/api/auth/dev-token`
- `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7910/api/v1/health`

结果：

- 当前本地 Vite proxy 仍可返回 dev token，HTTP `200`
- 上游 `Yuantus` 健康检查返回 `200`

## 非阻塞提示

### 1. 现有 live dev backend 进程没有在本轮被主动重启

本轮没有重启当前监听在 `7778` 的本地 backend 进程，避免打断用户现有运行态。

这意味着：

- 通过 `8899 -> /api/auth/dev-token -> /api/auth/me` 的 live proxy curl，仍可能看到旧进程返回的 `Invalid token`
- 这一现象不用于否定本轮源码修正，因为源码级验证已经证明新的 secret 对齐逻辑成立

### 2. `workflow` 真正是否可访问，仍由环境开关决定

[auth.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/auth.ts) 中 `workflow` feature 仍来自 `FEATURE_FLAGS.workflowEnabled`。

所以本轮之后：

- auth bootstrap 更稳定了
- 模式归一化更准确了
- 但若运行环境本身没开 `WORKFLOW_ENABLED=true`，`/workflows` 仍会被 feature gate 拦下

这是环境配置，不是这轮代码回归。

## 验证结论

这轮证明了四件事：

1. `apps/web` 的 workflow/bootstrap 已从“三处重复触发”收成“路由守卫主导”
2. workflow nav 和 route guard 已回到同一套 capability 语义
3. backend feature payload 已正式支持 `plm-workbench`
4. `dev-token` 和 `AuthService.verifyToken()` 的 secret 语义已经在源码层对齐

所以这轮之后，`workflow hub` 剩下的 dev 模式问题已经不再是“bootstrap 链本身不成立”，而主要是：

- 当前 live backend 进程是否已加载最新源码
- 以及运行环境是否真的打开了 `WORKFLOW_ENABLED`

这两项都属于运行态问题，不再是本轮代码结构问题。 
