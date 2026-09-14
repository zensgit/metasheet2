# 备料上手向导 ①拆分 + /stock-prep 门对齐 — 设计 (2026-09-10)

分支 `feat/stock-prep-wizard-split-and-gates`，叠在 `feat/data-sources-fold-into-workbench`（PR #5587）之上。

## 1. 为什么 ① 必须拆

整合切片（2026-09-09）把「外接数据源」并进了数据工厂的「连接管理」分区。那个分区里现在有**两个**控件，做两件事：

- 分区顶部的面板：登记一条物理连接 + 凭据，写 `data_sources`（`data-testid="connection-data-sources-panel"`）；
- 分区下方的外部系统绑定编辑器：新建一条连接草稿，kind `data-source:sql-readonly`，用 `connectionId` 引用上面那条（入口 `data-testid="connect-new-system"`）。

旧的第①步「接一条只读连接」一行同时描述了这两件事，而且**句子说的是第一件、徽章读的是第二件**：徽章来自 `binding.eligibleSourceCount`，也就是源绑定信封里的**外部系统**数量。那个信封对「有没有登记数据源」是沉默的——一个部署完全可以有一台可用的 SQL Server 而还没建绑定，此时旧①报「需要别人做」，而它的句子写的是「还没登记连接?」。给一个一小时前刚登记完数据源的管理员看这句话，就是叫人去做一件已经做完的事。

所以拆成两行，各有各的读、各有各的徽章、各有各的去向：

| 步 | key | 证据来源 | 去向 |
|---|---|---|---|
| ①a 登记外接数据源 | `source-register` | **新增**：`dataSourceRegistry.ts` 读 `GET /api/data-sources`，数关系型（postgres/postgresql/sqlserver/mysql）条数 | `/integrations/workbench#int-sec-connection`，文案点名「分区顶部的『外接数据源』」 |
| ①b 在数据工厂新增 SQL 绑定 | `source-connect`（沿用旧 key） | 旧①的证据不动：`binding.eligibleSourceCount` | 同一锚点，文案点名「下方『新增连接草稿』」 |

进度分母因此从 6 变 7；`StockPreparationWorkspace.vue` 的 rail 描述与 `StockPreparationHelpCard.vue` 的步骤列举同步改口，否则一页两个答案。

## 2. 与任务书的一处偏离（有意为之）

任务书写 ①b 的证据 =「至少有一个 `data-source:sql-readonly` 绑定」。**徽章没有这样算**，原因在服务端：`stockPreparationSourceBindingGet` 把 `eligibleSources` 收窄到 action 自己冻结的 `source.kind`（`listEligibleSources(..., { requiredKind })`）。BOM 可读的 kind 有两个——`data-source:sql-readonly` 和 `bridge:legacy-sql-readonly`——后者是合法且在跑的配置。只按前者算徽章，会对一个用旧式桥接喂了一线好几个月的部署报「没完成」。

折中：徽章读 `eligibleSourceCount`（任意可选绑定 > 0 即 done），而「走的是哪条路」放进证据行——新增投影字段 `dataSourceBackedSourceCount`（`countDataSourceBackedCandidates`，只数 kind 命中的那些，不做任何资格判断）。证据行因此有两种说法：「已登记 N 条，其中 M 条走外接数据源」/「已登记 N 条(都是旧式桥接，不经外接数据源)」。

## 3. ①a 的读：为什么敢在 mount 时跑

`GET /api/data-sources` 走 `rbacGuard('data_sources','read')`，命中 `DataSourceManager.listDataSources`——遍历进程内 adapter map，`connected` 读的是标志位，**不建连接**。D6（源预检永不随页面自动跑）管的是探客户数据库，这条不是，所以可以不问自跑，也正因此 ①a 才可能在没人按任何按钮之前就有答案。

投影是**值无关**的：路由返回 `{id,name,type,connected}`（平台管理员另有 `ownerId`），模块只输出 `{state, sqlCount, totalCount, status}`——一个状态两个整数，连接名根本没有出口。名单是 owner 作用域的（#5401），所以 0 的措辞是「本账号看不到」，不是「这台机器上没有」。

失败一律塌成 `unknown`（403/401/500/网络/HTML 冒充 200/形状不认识），`absent` 只在**真读到了**且没有关系型源时出现——「看不到」≠「没完成」。服务承诺永不 reject。

## 4. 链接门：两个链接一个布尔

两个去向都是同一个 `integration:write` 的数据工厂页。`stock-prep:admin` 持有者能开安装页、开不了那一页，所以给他们**句子不给链接**（denied testid `…-link-data-sources-denied` / `…-link-connection-draft-denied`），和第②步 `denied` 态同形。prop 名 `canOpenDataFactory`，与基分支 afcf9e374 同名；本分支声明为可选且**缺省 fail-closed**（`undefined` 不是 `true`，漏传就只渲染句子）。地图本身不受门影响——G5「地图不是闸机」，两行照常渲染、徽章照常说话。

## 5. 门对齐：分歧是真的，两个方向都错

`hasPermission('stock-prep:read')`（`useAuth.ts:521`）会展开：`stock-prep:*`、`*:*`、`:write`→`:read`，还把 `users:write` 当管理员。`satisfiesStockPrepAccess`（`workbenchAccess.ts:344`）按字面匹配，和服务端 `stock-preparation-workbench-access.cjs` 一致。此前 `App.vue:162` 与路由 meta 走前者，页面内部走后者，分歧被记录（`stockPrepPermissionMatrix.spec.ts` F-03 四行注释）而没被关掉：

- 裸 `integration:admin`：`satisfies` 答 true（它是 `PLATFORM_ADMIN_PERMISSIONS` 之一），`hasPermission` 答 false → **有权却被藏起来并被重定向**；
- `stock-prep:*` / `*:*` / `stock-prep:write` / `users:write`：`hasPermission` 答 true，服务端拒绝 → **看得见点不动**。

修法是让外壳问工作台自己那道门，不是放宽那道门：

- `canReachStockPrepWorkbench(snapshot) = satisfiesStockPrepAccess(snapshot, STOCK_PREP_ROUTE_PERMISSION)`，零新语义；
- `buildStockPrepAwarePermissionProbe`：**只有** `STOCK_PREP_PERMISSION_CODES` 三个码改由字面阶梯回答，其余权限逐字节仍走 `hasPermission`；取不到 principal 时 fail-closed，绝不回退到更宽的探针；
- `RouteGuardRuntimeDeps.auth` 增加**必填** `getAccessSnapshot`：这让**两个有类型的 src 调用点**（`main.ts:129`、`MyAppsLandingView.vue:149`）漏传时编译不过。这是对那两处的保证，不是对所有调用者的：测试里手搭的 deps 字面量、任何无类型的 JS 调用都不受它管——所以探针**另外**在运行时对读不到 principal 的情况 fail-closed，而不是指望类型拦住；
- `App.vue` 导航链接改用同一谓词。

**对齐的是四面，不是三面。** 除了导航链接、路由守卫、页面内部谓词，`MyAppsLandingView.vue:149` 的卡片可达性判定也走 `buildRouteGuardContext`，因此跟着这次改动一起对齐了（它自己的失败路径是 fail-OPEN 显卡，目标页自己的守卫仍然权威）。这一面**没有 pin**：本波的门 pin 只盖了前三面，卡片面是靠共用 `buildRouteGuardContext` “顺带”对齐的，有人给卡片另写一套判定不会被任何现有用例拦住。

`/stock-prep` 是 `appRoutes.ts` 里唯一在 meta 里声明这三个码的路由，所以别的路由行为不变。四种展开主体严格收紧（服务端本来就拒绝他们），`integration:admin` 那行不再遮住服务端已经在服务的页面——路由守卫只是外壳的可视性开关，它后面每条路由仍由服务端同一套阶梯把门，没有任何主体因此多拿到一个字节。
