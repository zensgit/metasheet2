# 外接数据源连接器 — 前端 UI 轨收口 + 门控 TODO(2026-05-31)

> 状态:**收口**。后端 + 部署轨的设计/门控见 `data-sources-mssql-windows-deploy-design-20260527.md`(§4 门控 TODO);本稿补齐**前端 UI 轨**——该轨此前按会话内规划逐切片落地,从未写入任何 committed 计划文档,导致"代码已完成、计划文档缺失"。本稿让 docs 与现实对齐,并把剩余前端切片显式列为 ⬜。
>
> 门控记号:🔒 待开闸 / ⬜ 待办未阻塞 / ✅ 完成。
>
> 轨纪律(贯穿全轨):**只读优先**(源数据零修改)、**凭据 write-only 过线**(后端从不回吐凭据,`sanitizeConfig` 剥离后只回 `hasCredentials`)、**不碰** integration-core / K3 `k3-wise-sqlserver` 通道 / central RBAC·auth。

---

## 1. 这是什么 / 边界

外接连接器在本轨之前是 **API-only**(后端 `routes/data-sources.ts` + `DataSourceManager` + 各 `*Adapter`)。本轨把它做成**可用的管理界面**:管理员能在 `apps/web` 里增/删/改/测一个外部数据源(Postgres / SQL Server / HTTP)。

- 落点:`apps/web/src/data-sources/`(`types.ts` / `api.ts` / `buildPayload.ts`)+ `apps/web/src/stores/dataSources.ts`(Pinia)+ `apps/web/src/views/DataSourcesView.vue` + `apps/web/tests/data-sources-ui.spec.ts`。
- **本轨 = 内核打磨/安全修复**(管理界面 + 编辑路径安全),lock-safe;不属于 🔒 的阶段二(数据流入 multitable,见 §4)。

---

## 2. 已交付(✅)

- ✅ **UI-1 列表/新建/删除**(#2147 `1054444a8`):`DataSourcesView.vue` 列表 + 新建表单 + 删除;`useDataSourcesStore`(items/loading/error)+ `listDataSources`/`createDataSource`/`deleteDataSource`;list 经 `data.items` 解包;凭据仅出站(create 携带,response 不回吐)。
- ✅ **UI-2 连接测试**(#2151 `d76b220c7`):每行 `GET /api/data-sources/:id/test` 触发;store `testing`/`testResults`;**请求层保持 `ok:true`**,连通失败体现在 `data.success===false`(不把传输层降级为 4xx)。
- ✅ **UI-3 非密编辑**(#2154 `a2390ad34`):编辑既有源的非密字段(name/connection 可见项/options);编辑态密钥提示 `ds-edit-secret-note`;凭据不在编辑表单回显。
- ✅ **凭据轮换路径**(#2160 `82d6317b2`):`PUT /api/data-sources/:id/credentials` 专用通道——轮换凭据与改非密字段解耦,避免"留空即清空"误删。
- ✅ **P1 编辑不丢隐藏安全键**(#2155 `6698c9b9a`,后端):`PUT` 对 `connection`/`options`/`poolConfig` **深合并**而非整体替换——编辑可见项不再静默丢掉 `encrypt`/`trustServerCertificate`/`tlsMinVersion` 等隐藏 TLS 键;回归测试 `data-source-readonly.test.ts` 锁定。
- ✅ **P2 + P2-followup `connection.server` 支持**(#2161 `e61b463ed`,前端):SQL Server 的 `server`-only 源可编辑;**且 server 语义限定 `type==='sqlserver'`**——builder 仅在 sqlserver 发 `connection.server`、提交守卫 Postgres 仍强制 `host`/SQL Server 接受 `host||server`、`watch(form.type)` 切换离开 sqlserver 即清空 `form.server`;`data-sources-ui.spec.ts` 21 例(含 "Postgres 不发 server")。

**当前 UI 能力面**:连 / 测 / 改(含凭据轮换)/ 删。后端已暴露但 UI 尚未 surface 的只读端点见 §3。

---

## 3. 剩余前端切片(⬜ —— surface-only,后端端点已就位)

这两片是**纯前端、surface 既有后端**(已验证后端路由在 main 上存在),各约等于 UI-2 体量,lock-safe:

- ⬜ **UI-schema 库表/字段浏览**:surface `GET /api/data-sources/:id/schema` + `GET /api/data-sources/:id/tables/:table`——让管理员看到源里有哪些表/字段。
- ⬜ **UI-preview 数据行预览**:surface `POST /api/data-sources/:id/select`(已被 A5 上限保护:`DEFAULT_LIMIT=1000`/`MAX_ROWS=10000`,超限 400)——只读预览若干行。

> **协作注意**:data-sources UI 一直由**并行会话**推进(UI-1/2/3 均其所出)。开这两片前需先与该会话对齐归属,避免重复/冲突(本轨曾发生 worktree 串线)。
>
> 完成这两片后,连接器作为**独立管理工具**即功能完整(连/测/改/删/浏览/预览)。

---

## 4. 真正的产品价值(🔒 gated,大头,未放行)

- 🔒 **读路径接入 multitable(import 流)**:已验证 `DataSourceManager` 当前仅被自身模块 + `routes/data-sources` + 内核 host(`index.ts`)引用,**从未被 multitable/import 调用**。即:用户能连接并浏览外部库,但**还不能把一张表 import 进 multitable**。这条接线 = 阶段二 / Data Factory 的实际落点,**gated + 设计暂停(待 K3 PoC 证据)**,非本轨范围,不在未开闸前启动。

---

## 5. 后端/部署轨收尾(交叉引用,不在本前端稿展开)

详见 `data-sources-mssql-windows-deploy-design-20260527.md` §4。截至本稿:

- ✅ A6 Postgres 适配器单测(#2139)——本次同稿把设计文档 §4 的过期 ⬜ 标记纠正为 ✅。
- ⬜ B0 抽共享 mssql helper(重构收口,解锁不了功能)。
- ⬜ B4 legacy 2008R2/2012 真机验证(需 Windows VM = 硬件门,非代码)。
- 🔒 B6 Windows 集成认证(`authType:'windows'`,独立设计)。
- 真 cursor stream:A5 只做了上限封顶,非真流式,留作后续 thorough。

---

## 6. 一句话结论

**独立工具距完成 ≈ 2 个前端小切片**(UI-schema + UI-preview,后端已就位);**真正的产品价值**(import 接入 multitable)是大头且**未放行**(阶段二 gated)。
