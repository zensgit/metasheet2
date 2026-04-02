# Workflow Live Dev Runtime Alignment 对标设计

日期: 2026-03-09

## 目标

上一轮已经把 `workflow dev auth bootstrap` 在代码层收口了，但如果不把 live dev 运行态一起验证，这条链仍然只算“源码正确”，还不算“本地开发真实可用”。

这轮的目标很明确：

1. 用新的 backend 源码真正替换掉旧的 `7778` 进程
2. 在 live dev 剖面下验证 `8899 -> /api/auth/dev-token -> /api/auth/me`
3. 在真实页面里确认 `/workflows` 不再回落，而是直达 `Workflow Hub`
4. 把这条运行时路径里的剩余重复请求显式暴露出来，而不是假装它已经完全收口

## 对标判断

如果对标 `Retool / n8n / 飞书流程工作台` 的本地开发体验，一条 feature gate 链至少要满足：

1. 当前代码修改能在下一次本地启动后立即体现
2. `auth/me` 返回的 feature 和 product mode 足以驱动真实路由落点
3. 页面首屏渲染要可观测，不是只看 curl 成功
4. 初始化链路里的重复请求要能被发现并被归类为“后续优化项”

所以这一轮的重点不是继续写功能，而是把 workflow 这条线从“代码层产品化”推进到“live dev 运行态产品化”。

## 设计决策

### 1. 重启时使用最小必要环境，而不是完全继承未知壳层

本轮 live backend 采用：

- `DATABASE_URL=postgresql://metasheet:metasheet123@localhost:5432/metasheet_v2`
- `PORT=7778`
- `NODE_ENV=development`
- `WORKFLOW_ENABLED=true`
- `PRODUCT_MODE=plm-workbench`

原因：

- `DATABASE_URL` 必须保持现有本地数据链不变
- `WORKFLOW_ENABLED=true` 是验证 workflow hub 的必要 feature 条件
- `PRODUCT_MODE=plm-workbench` 是验证 workbench 导航和首页落点的必要剖面

这不是“为了让测试过而硬改环境”，而是把 workflow 相关代码放到它本来就应该工作的运行剖面里。

### 2. 验证顺序采用 `curl -> proxy -> browser`

本轮验证分三层：

1. backend 进程启动并监听 `7778`
2. 通过 `8899` 代理验证 `dev-token -> auth/me -> plugins`
3. 用真实浏览器进入 `/workflows`

这样做的原因是：

- 先确认 backend 本身已切到新代码
- 再确认 Vite proxy 看到的是新 backend，而不是历史残留进程
- 最后才谈页面主体验证

### 3. 浏览器 smoke 只验证 workflow hub 的真实入口闭环

本轮 smoke 不追求复杂交互，只验证三件事：

1. 页面标题和 URL 都落在 `/workflows`
2. `Workflow Hub` 主体已渲染
3. 网络请求包含：
   - `/api/auth/dev-token`
   - `/api/auth/me`
   - `/api/workflow-designer/workflows`
   - `/api/workflow-designer/templates`

这样可以把“路由没回落”和“页面真的能用”同时锁住。

## 超越目标

这轮真正想超越的不是“重启了一次服务”，而是把 workflow 的 dev 体验从“源码层可证明”推进到“运行态可证据化”：

1. `dev-token -> auth/me` 不再只是单测结论，而是通过 `8899` 代理的 live 结果
2. `plm-workbench` 模式不再只是返回 JSON 的一个枚举值，而是体现在导航品牌和首页落点
3. `/workflows` 不再只是 route config 上存在，而是浏览器里可直达、可见、可截图
4. 重复 `/api/plugins` 这类剩余初始化噪声被正式纳入观察，而不是被忽略

## 本轮不做

- 不在这轮继续改 `usePlugins()` 去重
- 不把 workflow hub 再扩成新的产品功能
- 不继续修改 `WORKFLOW_ENABLED` 的默认配置策略
- 不把这轮变成完整的 Playwright 自动测试入仓

本轮只聚焦：

把 workflow 的 auth/bootstrap 修正真正落到 live dev 运行态，并留下可追溯的 smoke 证据。 
