# Platform Shell Wave 1 Review Fixes Design

日期：2026-04-13

## 背景

PR [#852](https://github.com/zensgit/metasheet2/pull/852) 在进入 review 后收到了 3 条可执行反馈：

1. `PlatformAppInstanceRegistryService` 的 JSON 字段解析缺少防御式兜底
2. 同服务对 `timestamptz` 映射只接受字符串，可能丢失 `Date` 值
3. `usePlatformApps().fetchAppById()` 缺少请求去重与统一 loading/error 状态管理
4. `platform-apps` 路由不应信任裸 `x-tenant-id` header 读取租户实例
5. `collectPlatformApps()` 每次请求都重新读盘解析 manifest，缺少缓存
6. `PlatformAppLauncherView` 模板重复调用 primary action 解析函数

这轮修正的目标不是扩功能，而是把 Wave 1 / 1.1 已经引入的平台壳运行模型补到可审查、可维护的水平。

## 设计原则

- 不改 API contract
- 不改 `after-sales` installer/current 协议
- 不改 `platform_app_instances` 表结构
- 只修正 review 指向的健壮性和状态一致性问题

## 变更设计

### 1. Instance registry 的 JSON 解析防御

文件：

- `packages/core-backend/src/services/PlatformAppInstanceRegistryService.ts`

调整：

- `parseJsonObject()` 对字符串输入增加 `try/catch`
- 当数据库值是损坏 JSON、空字符串、或驱动返回非对象 JSON 时，统一回退 `{}``

目的：

- 避免单条坏数据导致整次 app instance 查询抛出未捕获异常
- 把防御逻辑封装在 registry 映射层，不把脏数据分散暴露给调用方

### 2. Registry 时间戳映射兼容 `Date`

文件：

- `packages/core-backend/src/services/PlatformAppInstanceRegistryService.ts`

调整：

- 新增 `optionalIsoString()`
- `created_at` / `updated_at` 若为 `Date` 实例，则转成 ISO 字符串
- 若本身就是字符串，则继续沿用原有 `optionalString()` 逻辑

目的：

- 与 Node/Postgres 常见驱动返回 `Date` 的行为兼容
- 避免 `PlatformAppInstanceRecord.createdAt/updatedAt` 在正常场景下无故丢值

### 3. `fetchAppById()` 请求去重与共享状态一致性

文件：

- `apps/web/src/composables/usePlatformApps.ts`

调整：

- 为单 app 请求新增 `inflightByAppId`
- 为 list/single 请求统一引入 `pendingRequestCount`
- `fetchApps()` 与 `fetchAppById()` 共用：
  - `beginRequest()`
  - `endRequest()`
  - `loading`
  - `error`
- `fetchAppById()` 现在在发起请求前清理旧错误，并对同一 `appId` 的并发调用只发一次请求
- app 写回缓存时统一排序

目的：

- 避免同一个 shell 页面或多个组件并发请求同一个 app 时重复打 API
- 防止 `loading/error` 因 list/single 走不同状态机而出现 UI 不一致

### 4. 平台 app 路由只信认证租户上下文

文件：

- `packages/core-backend/src/routes/platform-apps.ts`

调整：

- `resolveTenantId()` 只读取 `req.user.tenantId`
- 不再回退信任原始 `x-tenant-id` header
- list 路由在缺少 tenant 上下文时，仍返回统一 shape，但所有 app 的 `instance` 明确为 `null`

目的：

- 避免 platform shell 在弱 tenant 模式或历史 token 场景下被请求头跨租户探测
- 让 `/api/platform/apps` 和 `/api/platform/apps/:appId` 在有无 tenant 上下文时都保持一致的响应形状

### 5. Manifest 读盘缓存

文件：

- `packages/core-backend/src/platform/app-registry.ts`

调整：

- 新增模块级 manifest summary cache
- cache key 采用 `plugin path + loadedAt`，以 plugin reload 作为失效边界
- 同一 loaded plugin 在重复请求时复用解析后的 summary，而不是重复 `fs.readFile + JSON.parse + zod parse`
- 对缺失/无效 manifest 也缓存 `null` 结果，避免重复无效 I/O

目的：

- 减少 `/api/platform/apps*` 的重复磁盘读取
- 保持“插件重载后失效”的简单一致性边界，而不引入更复杂的 watcher

### 6. Launcher 模板预计算 primary action

文件：

- `apps/web/src/views/PlatformAppLauncherView.vue`

调整：

- 把 `resolvePlatformAppPrimaryAction()`、install state、instance label、project label 从模板内多次调用收口为 `appCards` 预计算结构
- 模板只消费预计算结果，不再在 `v-for` 内重复执行同一套分支逻辑

目的：

- 降低模板重复计算
- 提高模板可读性
- 避免后续 action 逻辑继续扩展时把 template 变成分支堆叠区

## 风险控制

- 所有改动都局限在映射层和 composable 层，没有扩大到 route 或 plugin contract
- 前端没有引入新的全局 store，只是在现有 composable 内统一状态
- 时间戳和 JSON 防御都通过单测锁住，不依赖人工回归
- platform app 路由的安全修正没有改变 API path，只收紧 tenant 解析来源
- manifest cache 以内存换 I/O，失效边界清晰，不依赖后台 watcher

## 影响文件

- `packages/core-backend/src/services/PlatformAppInstanceRegistryService.ts`
- `packages/core-backend/tests/platform-app-instance-registry.test.ts`
- `apps/web/src/composables/usePlatformApps.ts`
- `apps/web/tests/usePlatformApps.spec.ts`
- `packages/core-backend/src/routes/platform-apps.ts`
- `packages/core-backend/src/platform/app-registry.ts`
- `packages/core-backend/tests/unit/platform-apps-router.test.ts`
- `packages/core-backend/tests/platform-app-registry.test.ts`
- `apps/web/src/views/PlatformAppLauncherView.vue`
