# admin 批量删改 `data_sources` 撞绑定 FK → 409 引用拒绝（#5896 后续，H2）

- 日期：2026-09-20
- 基线：`origin/main` = `1a6663a41`（已含 #5896 的 squash 合并）
- 前一刀：`docs/development/data-source-live-id-fk-binding-lock-design-20260920.md`（PR-B：`live_id` 生成列 + FK 重指 + 取消 force）
- 关闭的登记项：该设计 §7 覆盖矩阵**第 5 行**

## 1. 洞

#5896 把 `integration_external_systems.connection_id` 的外键改指 `data_sources(live_id)`（`ON DELETE RESTRICT NOT VALID`，迁移 `zzzz20260920120000`）。`live_id` 是 STORED 生成列：行活着时等于 `id`，`deleted_at` 一被写就变 NULL。

`routes/admin-routes.ts` 的两条批量路由把 `data_sources` 列在 `validTables` 里：

- `DELETE /api/admin/data/bulk` —— 硬删，直接 `db.deleteFrom('data_sources').where(...)`；
- `PUT /api/admin/data/bulk` —— 可以直接 `set({ deleted_at: ... })`，即绕过 `DataSourceManager` 的软删。

两条都是**在路由处理器里自己发 SQL**，没有服务层：`db` 来自 `src/db/kysely`，builder 就在 handler 内拼。所以 23503 是从 kysely 的 `execute()` 冒到 handler 的 `catch (error)`，而那个 catch 只有一句 `res.status(500).json({ success:false, error: err.message })`。

结果：对**被 canonical 绑定引用**的源做批量硬删/软删 → 数据库以 23503（约束 `fk_integration_external_systems_live_connection_id`）拒绝 → 客户端拿到**裸 500 + 驱动原文**。行没动（这点本来就安全），但没有稳定 code 可分支，而且驱动文本里会带 host/port/database/login 这类值面。

## 2. 做法：两层，都在最贴近 SQL 的那一层（路由）

因为发 SQL 的就是 handler 自己，"最贴近的一层"= `admin-routes.ts`。新增的三个模块级件都放在 `Data Operations (Protected)` 分区顶部：

| 件 | 作用 |
|---|---|
| `referencedRefusalBody(ids)` | 值面干净的 409 体：`{ success:false, error:<固定句>, code:'DATA_SOURCE_REFERENCED_BY_EXTERNAL_SYSTEMS', details:{ table:'data_sources', ids } }` |
| `findReferencedDataSourceIds(filters)` | 按**与变更同一套 filters** 解析目标 id，再查 `integration_external_systems.connection_id IN (ids)`，返回被引用的 id |
| `referencedDataSourceIdsForRefusal(filters)` | 上者的**顾问性**包装：查询本身失败不改变请求的命运，只记 SQLSTATE（不记驱动原文）并返回 `[]` |

**① 预检**（写之前）

- DELETE：`table === 'data_sources'` 时跑预检，有引用 → 409 带 `ids`，**一条 DELETE 都不发**。
- PUT：只在 `updates` 里**真的设了非空 `deleted_at`** 时跑预检。理由：`live_id` 只由 `deleted_at` 决定，改 `name` / `status` 根本不碰键列（PG 取 `FOR NO KEY UPDATE`），把它也拒掉会打断对被引用行的正常批量编辑；`deleted_at: null` 是"复活"，只会让 `live_id` 出现，同样不拒。

**② 兜底映射**（catch 里）

```ts
if (table === DATA_SOURCES_TABLE && isLiveConnectionFkViolation(err)) { ... 409 ... }
```

`isLiveConnectionFkViolation` 与 `DATA_SOURCE_REFERENCED_BY_EXTERNAL_SYSTEMS_CODE` **直接复用** `DataSourceManager.ts:50 / :31`，没有另造一套判定：SQLSTATE `23503` 主判，约束名（live / 迁移前 legacy / 驱动缺省）次判，**永不读英文散文**——222 是 zh_CN locale，`violates foreign key constraint` 那句英文根本不出现（仓库记忆：PG locale 守卫横扫）。

为什么两层都要：预检是**唯一能报出 id** 的一层；兜底是**唯一能保证没有裸 500** 的一层（预检与写之间提交的绑定、以及预检自身查不动的情况，都只有数据库拦得住）。

## 3. 边界（明确不做的）

- **只认 canonical 形态**（`connection_id`）。legacy 形态（`connection_id IS NULL` + `config->>'dataSourceId'` + owner 戳）没有 FK，批量变更不会撞，预检也不查它——查了就等于宣称一个数据库并不提供的保证。仍登记在上游设计 §7 的 uncovered。
- **别的 23503 不动**：约束名不是那两个之一 → 保持 500。
- **别的目标表不动**：`table !== 'data_sources'` 连预检都不跑，catch 也不映射（即便错误里带的就是绑定约束名）。
- **不加/不改鉴权**：这两条路由今天只有 `requireSafetyCheck`，没有 `requireAdminRole`。这是既有事实，属 ADM-05 那条线，本 PR 不动它（见残余）。
- **预检失败不升级成新的 500**：权威守卫是数据库约束；一个查不动的预检不该把本来能成功的批量变更变成失败。代价有界——refusal 的 `ids` 可能为空，状态码永远不会错。

## 4. 覆盖矩阵联动

上游 `data-source-live-id-fk-binding-lock-design-20260920.md` §7 第 5 行由 `uncovered` 改为 `covered（canonical）`，并指回本文件。其余 uncovered 项（legacy 形态、`integration_stock_prep_source_binding` 等持指针不计数的表、存量悬空行）一字未改。

## 5. 未改动

`DataSourceManager.ts`、迁移、插件 `external-systems.cjs`、openapi、前端、任何 env flag —— 均未触碰。本 PR 只改 `routes/admin-routes.ts` 一个源文件 + 一个新 spec + 两份文档。
