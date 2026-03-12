# Workflow Dev Auth Bootstrap 对标设计

日期: 2026-03-09

## 目标

上一轮已经把 `workflow hub` 的生命周期、模板目录和运行时 schema 收到了可用状态，但 dev 模式下还留着一条真实尾项：

1. `router.beforeEach`、[App.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/App.vue) 和 [HomeRedirect.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/HomeRedirect.vue) 会重复触发 feature bootstrap
2. 前端已经支持 `plm-workbench`，但 backend `/api/auth/me` 仍只会返回 `platform | attendance`
3. `workflow` 不可用时，导航仍会暴露 `/workflows`
4. `/api/auth/dev-token` 的签名 secret 仍走独立逻辑，和 [AuthService.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/auth/AuthService.ts) 的 `SecretManager` 取值链不一致

这一轮的目标不是继续堆 workflow 功能，而是把这条 dev bootstrap 链变成可解释、可验证、可继续扩展的基础设施。

## 对标判断

如果对标 `Retool / n8n / 飞书流程中心` 这类工作台，本地 dev 体验至少应该满足三件事：

1. 首页和目标页只做一次 capability bootstrap，而不是多处重复试探
2. 产品模式和 feature gate 必须由后端统一给出，不能前后端各说各话
3. 不可用能力不应该在导航层继续暴露成可点击入口

当前代码在结构上已经接近这条目标线，但 dev 细节还没完全收口。

## 设计决策

### 1. 路由守卫成为唯一 feature bootstrap 入口

[main.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/main.ts) 的 `beforeEach` 已经承担：

- `loadProductFeatures()`
- `requiredFeature` 检查
- `attendance-focused / plm-workbench` 入口限制

所以这轮把 [App.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/App.vue) 和 [HomeRedirect.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/HomeRedirect.vue) 里的重复 `loadProductFeatures()` 去掉，让 route guard 成为单一 bootstrap authority。

这样做的目的不是“少一次函数调用”，而是避免 dev token / `/api/auth/me` 在 clean session 里出现多次并发请求。

### 2. `/api/auth/me` 的产品模式必须和前端支持面一致

前端 [featureFlags.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/stores/featureFlags.ts) 已经支持：

- `platform`
- `attendance`
- `plm-workbench`

但 backend [auth.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/auth.ts) 之前只会把 `PRODUCT_MODE` 归一化成 `platform | attendance`。

这会让真正打开 `plm-workbench` 配置时，首页落点和 feature guard 仍然偏向 `platform`。本轮把它扩成：

- `attendance / attendance-focused -> attendance`
- `plm-workbench / plmWorkbench / plm-focused -> plm-workbench`
- 其他 -> `platform`

### 3. 导航必须服从 capability，而不是只服从页面存在

既然 `/workflows` 在 [main.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/main.ts) 上已经受 `requiredFeature: 'workflow'` 约束，那么 [App.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/App.vue) 也不应该在 `workflow` 不可用时继续展示它。

这一轮把 workflow nav link 收到 `hasFeature('workflow')` 之下，避免用户点击后再被重定向回首页。

### 4. `dev-token` 必须复用和 `AuthService` 一致的 secret 语义

本轮最关键的对齐点在 backend：

- [AuthService.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/auth/AuthService.ts) 通过 `SecretManager` 读取 `JWT_SECRET`
- [auth.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/auth.ts) 的 `/dev-token` 之前只读 `process.env.JWT_SECRET`

这会在 `SECRET_PROVIDER=file` 或其他 secret provider 场景下制造“能签但不能验”的 dev token。

所以本轮把 `/dev-token` 也改成复用 `SecretManager` 语义，再落回同一个 development fallback。

## 超越目标

这轮真正想超越的不是“让 `/api/auth/dev-token` 多一个 helper”，而是把 dev 模式从“靠 localStorage 和偶然顺序能跑”推进到“结构上自洽”：

1. feature bootstrap 只走一条主链，而不是三处并发尝试
2. `plm-workbench` 模式终于在 backend feature payload 上成为一等值
3. workflow 入口在导航层和路由层保持同一套能力语义
4. dev token 的签发和验签终于回到同一 secret 体系

## 本轮不做

- 不在这轮修改 `WORKFLOW_ENABLED` 的环境默认值
- 不强行把 `/workflows` 在 feature disabled 时改成可访问
- 不重启现有本地 dev 进程来替换用户当前运行态
- 不继续扩展 `usePlugins()` 的去重策略
- 不把这轮变成整套 auth system 重构

本轮只聚焦：

把 `workflow` 相关的 dev auth bootstrap 从“行为上偶尔可用”收成“代码结构上成立”。 
