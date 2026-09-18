# 外接数据源并入数据工厂「连接管理」分区 — 设计稿(2026-09-10)

> 对应分支 `feat/data-sources-fold-into-workbench`,PR #5587,HEAD `afcf9e374`。三个提交:`ee5557408`(抽组件)→ `7eff1e8d2`(并入 + 重定向 + 落点)→ `afcf9e374`(对抗复核终审修复)。

## 背景

- 折叠前顶栏并列挂着三个入口:「系统集成」(`canUseIntegration` → `/integrations/workbench`,即数据工厂工作台)、「备料」(`canUseStockPreparation` → `/stock-prep`)、「外接数据源」(同样挂 `canUseIntegration` → `/data-sources`)。后者虽与「系统集成」共用同一权限门,却是完全独立的页面,和数据工厂工作台在信息架构上割裂:登记连接在 `/data-sources`,用连接在工作台的连接草稿编辑器里,两者除了 `connectionId` 字符串外没有页面级关联。
- 原始设计 `docs/development/data-factory-sql-data-source-readonly-source-bridge-design-20260601.md` 与其执行计划 `docs/development/data-factory-sql-data-source-bridge-execution-plan-todo-20260601.md` 在 2026-06-01 就把这件事列进路线图,标记为 **🔒 C4 — UI unification (only after the bridge runs stably)**,写明约束"UIs separate until C4 — the workbench references `/data-sources`, does not absorb it."。C1/C2(adapter + runner + 工作台的 `data-source:sql-readonly` picker)2026-06-02 落地并稳定运行三个月后,本 PR 是 C4 的执行。

## 决策

### 1. 登记表留在后端真源,不新建/不拆分数据模型

`data_sources` 表、`routes/data-sources.ts`、`useDataSourcesStore` 全部不变 —— 只动前端呈现层,遵循 C0 定的"两栈解耦、只做薄桥"边界,不把凭据管理并进 plugin-integration-core。

### 2. 独立页折进数据工厂工作台的「连接管理」分区,不建新路由/新组件树

挂载点是 `IntegrationConnectionSection.vue`,复用工作台已有的分区滚动模型,不给工作台加二级路由。

### 3. `/data-sources` 保留为重定向,不下线路由

`redirect: { path: '/integrations/workbench', hash: '#int-sec-connection' }`,`name`/`meta.title` 不变,只去掉 `component`。旧书签、外部文档、备料向导里写死的路径继续可达。

### 4. 落点用 hash/`?section=`,不用二级路由

工作台是一次性渲染全部分区、靠滚动切换的单页(~5.2k 行 SFC),深链语义是"滚到哪个分区",不是"挂载哪个组件"。落点解析抽成纯函数 `views/integrationWorkbenchLanding.ts`,section id → rail 分组 id 的映射也搬过去,让深链解析与 `IntersectionObserver` 高亮共用一张表 —— 避免"能滚动定位却点不亮 rail 项"或反过来。

### 5. 顶栏删掉「外接数据源」独立导航项,不删路由标题

`navLabels.dataSources` 键保留(仍是 `/data-sources` 路由的 `meta.titleZh`),`App.vue` 里的 `<router-link>` 整行删除。

## 结构

### `DataSourcesPanel.vue`(新增,`components/data-sources/`)

`DataSourcesView.vue` 原有 template/script/style 逐字搬入,view 降为薄壳(`ee5557408`)。仅新增两处差异:`embedded?: boolean`(默认 `false`;独立挂载渲染 `<h1>` + 英文副标题 + 页面级 padding/max-width,`embedded` 时不渲染自身标题、内层结构/预览标题 `<h2>` → `<h4>`,不隐藏任何控件、不改任何 store 调用,两种挂载走同一套服务端权限门);`changed` emit(`create`/`update`/`rotateCredentials`/`delete` **成功后**才触发,免得宿主失败后 refetch 画出旧列表)。

### `IntegrationConnectionSection.vue`

onboarding 块之后、inventory toggle 之前挂 `<DataSourcesPanel embedded @changed="handleDataSourcesChanged" />`,容器 `data-testid="connection-data-sources-panel"`,小标题「外接数据源(物理连接与凭据)」+ 一句说明(凭据只存这里,下方连接草稿只用 connectionId 引用)。新增可选 prop `onDataSourcesChanged`(与既有 `onBridgeDataSourceChange` 同形状的函数 prop,不是 emit 监听器),面板 `changed` 转调它。

### `IntegrationWorkbenchView.vue`

传入 `:on-data-sources-changed="refreshBridgeDataSourcesAfterPanelChange"`。该函数清空 `bridgeDataSourcesLoaded`(这是"首次展开才拉"的惰性优化标志,不是刷新策略,不清的话新建的源永远进不了 connectionId 下拉)、清空上次失败留下的错误串、重新拉取列表,并调用 `pruneConnectionDraftDataSourceReference()`(见"对抗复核"节)。落点解析走 `resolveWorkbenchLandingGroupId(route)`:先读 `route.hash` 再读 `route.query.section`,都没有则返回 `null`(不动当前滚动位置,不清高亮);`onMounted` 后 `nextTick` 执行一次,并 `watch` hash/query 变化重跑。`useRoute()` 在无 router 的裸挂载 spec 里是 `undefined`,所有读取走可选链。

### `views/integrationWorkbenchLanding.ts`(新增纯函数模块)

`resolveWorkbenchLandingGroupId` + `WORKBENCH_SECTION_GROUP_IDS`(section DOM id → rail 组 id 映射表)+ `WORKBENCH_RAIL_GROUP_IDS`(`?section=` 白名单)。抽出是因为宿主 SFC 太大,没法轻量挂载单测,决策逻辑搬出来后可以直接对函数写单测。

### 路由(`appRoutes.ts`)

`/data-sources` 从渲染 `DataSourcesView` 改为 `redirect`,目标带工作台自己的 `integration:write` 门(下节详述);目标路径落在 `PLM_WORKBENCH_ALLOWED_PREFIXES` 已有的 `/integrations` 前缀内,白名单未改动,PLM 聚焦模式下反而从"必被弹回 `/plm`"变成可达。

### 备料向导(`StockPreparationGettingStarted.vue` / `StockPreparationInstallView.vue`)

①「还没登记连接?」链接改指 `/integrations/workbench#int-sec-connection`,且必须用 `<a>` 不用 `<router-link>` —— 该组件在自己的 spec 里裸挂载,没有 router 也没有 stub,`<router-link>` 会静默解析不出来,把链接连同它解释的那一步一起从页面上抹掉。

## 权限语义变化

- `/data-sources` 原只要求 `requiresAuth: true`(登录即可);重定向后落在工作台路由自己的 `integration:write` 门后面。这是**收紧**,不是放松:旧顶栏的「外接数据源」链接本来就只对 `canUseIntegration`(即 `integration:write`)渲染,和「系统集成」同一个门 —— 从导航点进来的人集合不变。
- 但直接敲旧 URL / 用书签 / 走备料向导①链接、且没有 `integration:write` 的主体,行为从"渲染独立页面"变成"被工作台路由守卫弹回首页"。终审阶段把这条从"暗改"改成"明写":`appRoutes.ts` 重定向处注释点名 `stock-prep:admin ∧ ¬integration:write` 这个真实存在的主体(交付指南把「开始使用」列为该主体可见项,harness 的 `stockadmin` actor 正是只有 `stock-prep:admin` 没有 `integration:write`)会被弹回。
- 对应地,`StockPreparationGettingStarted.vue` 新增 `canOpenDataFactory?: boolean` prop(**默认 `false`,fail closed**),由 `StockPreparationInstallView.vue` 用 `useAuth().hasPermission('integration:write')` 计算后传入 —— 与路由守卫同一个探针,链接只在探针为真时渲染,否则渲染纯文本告知需要哪个权限、找谁登记。一个看得见链接却点进去被弹回首页的按钮,比"看不见"更隐蔽;同探针门渲染让链接消失时页面同时给出可操作的替代路径。

## 已知近似

- **hash 落点补偿一次**:`onMounted` 首次执行 `applyWorkbenchLanding` 后,`refreshBootstrap` 完成时再补跑一次(终审 F01,`afcf9e374` 新增),弥补挂载时上方总览分区数据晚到把连接分区往下推的偏移;仅一次性,更晚落地的异步内容或用户手动滚动仍可能让落点跑偏,不做持续修正是刻意取舍,避免覆盖用户手动滚动。
- 面板嵌入分区后**始终展开**,分区因此变长;折叠开关留后续,本次不做。
- 每次工作台挂载**多一次 `GET /api/data-sources`**(面板自己的 `onMounted` 拉一次列表),没有和工作台既有的惰性加载合并。
- **`?section=` 目前无生产调用方**,只是为深链预留的形状,当前唯一真实来源是 `#int-sec-connection`(`/data-sources` 重定向)。

## 对抗复核后的修复(`afcf9e374`)

`7eff1e8d2` 落地后走了一轮对抗复核:3 个查找视角(正确性 / 权限安全 / 产品可用性)→ 每条发现 2 个反驳者 → 终审。判定必修 4 条 + 后续 3 条,全部在 `afcf9e374` 里修完:

- **注释诚实性**:`appRoutes.ts` 重定向注释补上"哪些主体会被弹回"(见上节);redirect spec 断言 meta 的用例改口(vue-router 在 `beforeEach` 前已消费 redirect 记录);`App.vue` 删掉一处不实的 `navLabels` 说明。
- **向导①链接门**:见上节,新增 `canOpenDataFactory` prop。
- **标题接缝**:`DataSourcesPanel` 嵌入时不再渲染自身标题,内层结构/预览标题 `<h2>` → `<h4>`。
- **同页删源 → 草稿悬挂**:面板可在同一屏删除连接草稿正引用的数据源。刷新列表后若 `connectionDraft.connectionId` 不在新列表里,清空该引用与对象选择,并取消在飞的 schema 读(新增 `pruneConnectionDraftDataSourceReference`);只对**真正重读成功**的列表生效,一次失败的重载不会误清仍然有效的引用。
- **F04**:`loadBridgeDataSources` 加独立 request ticket(`bridgeDataSourcesRequestId`),面板变更触发的刷新与 picker 首次展开的惰性加载可能同时在飞,没有 ticket 时旧结果会覆盖新结果。
- **F09/F14**:四处写死「/data-sources」路径的提示文案改指「上方「外接数据源」面板」。

## 不做的事

- 不把 `DataSourceManager` / `routes/data-sources.ts` 移位或并入 plugin-integration-core(C0 定的两栈解耦边界不动)。
- 不重排备料页 rail 分组顺序,不动备料向导以外的其它导航布局。
- 不做 C3(watermark 增量读)、C5(K3 SQL Server 复用生成式 MSSQL 层)、C6(外部库写)—— 仍按原路线图挂 🔒,本次不解锁。
