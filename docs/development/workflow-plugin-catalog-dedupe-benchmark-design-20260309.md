# Workflow Plugin Catalog Dedupe 对标设计

日期: 2026-03-09

## 目标

上一轮已经把 `workflow live dev runtime` 跑通，但浏览器 smoke 里仍然还能看到一次多余的 `/api/plugins`。

这说明问题已经不在：

1. `dev-token -> auth/me`
2. `workflow hub` 路由回落
3. `plm-workbench` 模式识别

而是在：

`App shell` 在 feature mode 还没稳定落定时，仍可能抢跑插件目录初始化。

本轮目标很明确：

1. 在不影响 `/workflows` 首屏可用性的前提下，去掉 `plm-workbench / workflow` 壳层下这次残余的 `/api/plugins`
2. 保持 `Workflow Hub`、模板目录和流程草稿目录继续正常渲染
3. 把结果通过真实浏览器 network log 固化下来，而不是只靠代码阅读判断

## 对标判断

如果对标 `Retool / n8n / 飞书流程工作台` 这类平台壳首屏体验，`workflow workbench` 启动阶段至少应该满足：

1. feature gate 能先于插件导航决策完成
2. 不属于当前 shell 的目录请求不应抢跑
3. 首屏主任务只加载当前页面真正需要的 catalog 和 data
4. 页面编排层不应该因为默认平台壳逻辑，继续触发与当前模式无关的初始化调用

上一轮已经做到第 `1~3` 条的大部分，但还差最后一步：把 `App.vue` 里这次残余的插件目录拉取彻底收掉。

## 设计决策

### 1. `App.vue` 先等 feature flags，再决定是否拉插件目录

本轮的核心决策是：

在 [App.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/App.vue) 的 `onMounted()` 中，先调用 [featureFlags.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/stores/featureFlags.ts) 的 `loadProductFeatures()`，再根据：

- `attendanceFocused`
- `plmWorkbenchFocused`

决定是否继续执行 `fetchPlugins()`。

原因很直接：

- `attendance` 壳本来就不需要平台插件导航
- `plm-workbench` 壳也不需要平台插件导航
- 只有通用 `platform` 壳才需要这次 `plugins catalog`

如果不等待 feature flags，`App shell` 就会在 mode 尚未解析完成时按“平台默认值”抢跑。

### 2. 不把这轮扩展成新的插件缓存架构

本轮不额外引入：

- 全局 `plugins store`
- 跨页面 catalog cache bus
- `/api/plugins` shared promise registry

原因是当前问题已经收缩成启动顺序问题，而不是 catalog 数据模型问题。

先把顺序修正，再决定是否有必要继续做“全局共享插件目录”。

### 3. 验证采用 `web gates + live smoke`

本轮验证分两层：

1. 代码级：
   - `pnpm --filter @metasheet/web test`
   - `pnpm --filter @metasheet/web type-check`
   - `pnpm --filter @metasheet/web lint`
   - `pnpm --filter @metasheet/web build`
   - `pnpm lint`
2. 运行态：
   - `curl http://127.0.0.1:7910/api/v1/health`
   - Playwright 隔离会话打开 `http://127.0.0.1:8899/workflows`
   - 采集 snapshot / screenshot / network log

这样能同时锁住：

1. `apps/web` 没被改坏
2. live `workflow hub` 没回退
3. `/api/plugins` 真的从运行时链路里消失

## 超越目标

这轮真正想超越的不是“再少一次请求”本身，而是把 `workflow/plm-workbench` 壳层进一步产品化：

1. 当前 shell 只加载当前 shell 真的需要的数据
2. `feature mode` 不再只是路由守卫语义，而开始主导首屏初始化顺序
3. `App shell` 从“平台默认壳”转成“按产品模式收敛的编排壳”
4. `/workflows` 首屏网络面变得更干净，后续再做性能治理时有明确基线

## 本轮不做

- 不把 [usePlugins.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/composables/usePlugins.ts) 改造成全局共享缓存
- 不继续改 `/api/plugins` 后端契约
- 不把这轮扩展成新的插件市场/插件管理功能
- 不把 `workflow hub` 再扩成新的业务功能

本轮只聚焦：

把 `workflow/plm-workbench` 启动阶段最后一次多余的插件目录请求收掉，并留下可追溯的 live 证据。
