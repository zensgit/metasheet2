# DataSourceManager.removeDataSource 失败开放顺序修复（PERM-04）设计

- 日期：2026-09-16
- 分支：`fix/data-source-remove-ordering`
- 基线：`origin/main` = `38caaf17bfc8eeca23e23f6dfe796683d35ab525`
- 缺口编号：缺口审计矩阵 PERM-04
- 相关：PR #5401（referential delete / 连接可管理化）、PR #5452（SQL 连接绑定统一，`integration_external_systems.connection_id` canonical 形态）

## 1. 验收出处（实读原文）

`docs/integration-consolidation-minimal-plan-20260901.md` §「PR-2：权限、引用追踪和安全删除」实施要求与验收原文：

- 实施要求（L212）：
  > 增加 Connection 引用查询；迁移期必须同时检查新 `integration_external_systems.connection_id` 和 legacy `config.dataSourceId`。任一种引用存在时，soft/hard DELETE 都返回 `409` 和 values-free consumer 信息；不能只依赖不会被 soft delete 触发的 FK。
- 实施要求（L213）：
  > 删除必须在事务中先检查引用并更新数据库，提交后才清理内存。
- 问题定位（L217-218）：
  > 当前删除路径可能先删除内存实例，再处理数据库：`packages/core-backend/src/data-adapters/DataSourceManager.ts:506-543`。该问题必须在统一引用后修复，避免连接重启后"复活"。
- PR-2 验收第 5 条（L226）：
  > 删除失败不会改变内存状态，重启后不会复活。

本次只做 L213 + L226 这条顺序问题；L212 的双形态引用查询在 #5401/#5452 已实现（`countExternalSystemReferences`），本次把它挪到 manager 删除流程的最前面复用，不改其语义（注意：仍未包进数据库事务，见 §5.2）。

## 2. Bug：失败开放的顺序

基线 `packages/core-backend/src/data-adapters/DataSourceManager.ts:819-856`（38caaf17b）的顺序是：

1. `adapter.disconnect()`（释放连接）
2. `adapter.removeAllListeners()` / `adapters.delete` / `connectionPool.delete` / `scopes.delete`（清内存）
3. 才写库（soft delete `deleted_at` + `is_active=false`，或 `hardDelete` 时物理删）
4. 写库失败 **只 `console.warn`**，方法照常 resolve

调用链：`DELETE /api/data-sources/:id`（`packages/core-backend/src/routes/data-sources.ts:818-904`）
→ `manager.assertAccess` → `manager.getDataSource`（取 config 供审计）
→ `manager.countExternalSystemReferences`（409 / 403 force 门）
→ `manager.removeDataSource(id)` → `auditLog(action='delete')` → `200 { removed: true }`。

于是数据库写失败时：

- 路由返回 `200 { id, removed: true }`，并且写了一条"删除成功"的审计；
- 进程内该 id 已经不在 `adapters`，`GET /api/data-sources/:id` 变 404；
- 但 `data_sources` 行仍是 `is_active = true AND deleted_at IS NULL`，下次重启 `loadFromDatabase` 按同样条件重新加载——数据源"复活"。

也就是说：内存与行不一致，且不一致的方向是危险的那一侧（用户以为删掉了，凭据与连接注册在重启后回来）。这正是 L226 验收要否定的状态。

## 3. 新顺序

`packages/core-backend/src/data-adapters/DataSourceManager.ts:856-925`：

1. **① 引用检查**（:862）：`options.force !== true` 时先跑 `countExternalSystemReferences(id)`（:656，canonical `connection_id` + legacy `config.dataSourceId` 加 owner 归属戳的双形态）。计数 > 0 抛带 `status: 409` / `code: DATA_SOURCE_REFERENCED_BY_EXTERNAL_SYSTEMS` / `details.referenceCount` 的错误。此时任何内存或持久状态都还没动，并且 `scopes` 还在——引用计数按 owner 归属，必须在 `scopes.delete` 之前读。
2. **② 先写库**（:879）：soft delete（或 `hardDelete` 时物理删）。
3. **② 的失败 → 抛错**（:900-908）：新增 values-free code `DATA_SOURCE_DELETE_NOT_PERSISTED`（:36），`status: 500`。驱动原文（host/port/database/login）只进 `console.warn` 日志，客户端拿到固定句子加它自己给的 id。此路径下 `adapters` / `connectionPool` / `scopes` 一字节不动，连接也不断开。
4. **③ 清内存**（:912）：`adapters.delete` / `connectionPool.delete` / `scopes.delete`，只在行确实删掉之后。
5. **④ 释放资源放最后**（:917）：先 `removeAllListeners()` 再 `disconnect()`，`disconnect` 失败只 `console.warn`，不回滚 ②/③。

### 为什么 disconnect 放最后

- 断开连接是**不可撤销**的副作用。放在写库之前意味着：写库失败时用户的连接已经被踢掉了，而删除并没有发生——一次失败的删除变成了一次静默的"断线"。放在写库之后，失败路径完全无副作用。
- 反过来，`disconnect` 失败不能回滚删除：行已经删了、内存也已经清了，为了一个泄漏的 socket 把行恢复回去，恢复出来的正是本次修复要消灭的幽灵（行活着、内存没有）。所以 ④ 只 warn。
- 顺序改了以后 `disconnect()` 发生在软删之后，adapter 的 `'disconnected'` 事件会触发 `updateStatus(id,'disconnected')`，那是一条写到刚被软删的行上的 UPDATE（它不清 `deleted_at`/`is_active`，不会复活，但是无意义）。因此在 ④ 里**先** `removeAllListeners()` **再** `disconnect()`，把这条回写掐掉。全仓只有 `DataSourceManager` 自己 emit `adapter:disconnected`（`:715`），没有任何消费者，静音不影响别处。

### `force` 与路由契约

- （**历史描述，PR-A 当时成立；2026-09-20 起 force 已取消**，现状见 `data-source-live-id-fk-binding-lock-design-20260920.md` §3：任何层级带不带 force 都是 409，`forcedReferenceBreak` 不再审计。）路由契约**未变**：`?force=true` 仍由路由判定（`referenceCount > 0` + `actor.platformAdmin === true`，否则 403 `DATA_SOURCE_FORCE_DELETE_ADMIN_ONLY`；不带 force 则 409 带 `details.referenceCount`），审计仍记 `forcedReferenceBreak` + `referenceCount`。
- 路由把这个**已经授权过**的判定透传给 manager：`packages/core-backend/src/routes/data-sources.ts:861` `removeDataSource(id, { force: forcedReferenceBreak })`。传的是 `forcedReferenceBreak`（引用存在 **且** 是平台管理员）而不是 `forceRequested`，所以一个"带了 force 但本来就没引用"的请求不会拿到 manager 侧的豁免。
- manager 自己**重新数一遍**，而不是信任调用方传进来的数字。直接调 manager 的非路由调用方（将来的后台任务、脚本）因此也过同一道门——这是收紧，不是放松。
- 路由 catch 里新增 `codedGateRefusal(error)` 映射（`routes/data-sources.ts:891`），让 manager 的 409 / `DATA_SOURCE_DELETE_NOT_PERSISTED` 保住自己的 status 与 code，而不是塌成一个读起来像"删了一半"的通用 500。

## 4. 与 #5401 / #5452 的关系

- **#5401** 建立了 referential delete 门：409 code、`force` 逃生门、按 owner 归属的计数、42P01 短路（只认 SQLSTATE，不认散文）。本次不动这些语义，只把这道门从"路由里的前置检查"同时也变成"manager 删除流程开头的第一步"，并让它在写库之前发生。
- **#5452** 引入 canonical `integration_external_systems.connection_id`，使计数变成双形态（canonical + legacy 指针 + owner 戳）。本次复用 `countExternalSystemReferences`，没有新增查询形态。
- 本次新增的只有：顺序、`DATA_SOURCE_DELETE_NOT_PERSISTED` code、manager 侧的 `force` 参数、路由 catch 的 coded 映射。

## 5. 计划外偏离 / 待裁决

1. **`force` 逃生门本身未动（已裁：取消）**。minimal-plan L212 的字面要求是"任一种引用存在时，soft/hard DELETE 都返回 409"，而 #5401 给了平台管理员 `force=true` 的审计化破坏通道。本 PR 当时**不改**、只登记。→ **owner 于 2026-09-20 裁决为 ① 取消 force**：有引用即不可删，由数据库兜底（`data_sources.live_id` 生成列 + FK 重指），平台管理员要删须先解绑。落地见 `data-source-live-id-fk-binding-lock-design-20260920.md` §3。
2. **没有用数据库事务（BEGIN/COMMIT）**。L213 原文是"在事务中先检查引用并更新数据库"。本次实现是"先检查、再单条写"，两步之间没有事务包裹：
   - 已经收紧的部分：检查一定在写之前，写一定在清内存之前，失败一定抛错。
   - 仍然存在的窗口：计数读到 0 之后、软删写入之前，若有人并发创建一条引用，这条引用会被悬空。窗口是一次读+一次写之间，且路由层还有一次更早的同样检查。
   - 没做事务的原因：`DataSourceManager` 持有的是裸 `Kysely<unknown>`，`countExternalSystemReferences` 与写入分别走各自的 builder；把它们塞进一个 `db.transaction()` 需要把 db 句柄在这两个方法之间传递（改 `countExternalSystemReferences` 的签名，而它是 #5401 的既有守卫，多处被测试直接调用）。这属于比"修顺序"大的改动，留给后续。
   - 建议后续做法：给 `countExternalSystemReferences` 加一个可选的 executor 参数，`removeDataSource` 在 `db.transaction().execute(trx => ...)` 内把 `trx` 传进去，并对 `data_sources` 行加 `FOR UPDATE`。
3. **多了一次计数查询**。路由先数一次（为了 409 的 message 与 `details.referenceCount`），manager 再数一次（为了不信任调用方）。每次删除多一次 COUNT，删除是低频操作，接受。
4. **`hardDelete` 仍然只有内部可达**：路由不暴露它，`removeDataSource(id, { hardDelete: true })` 没有生产调用方。它跟着走同一套顺序，不新增暴露面。

## 6. 改动清单

| 文件 | 内容 |
|---|---|
| `packages/core-backend/src/data-adapters/DataSourceManager.ts:36` | 新增 values-free code `DATA_SOURCE_DELETE_NOT_PERSISTED` |
| `packages/core-backend/src/data-adapters/DataSourceManager.ts:856-925` | `removeDataSource` 改为 引用检查 → 写库 → 清内存 → 释放连接；写库失败抛错 |
| `packages/core-backend/src/routes/data-sources.ts:861` | 透传 `{ force: forcedReferenceBreak }` |
| `packages/core-backend/src/routes/data-sources.ts:888-894` | DELETE catch 增加 `codedGateRefusal` 映射 |
| `packages/core-backend/tests/unit/data-source-remove-ordering.test.ts` | 新增 12 个用例（manager 9 + 路由 3） |
| `packages/core-backend/tests/unit/data-source-scope.test.ts:121-136` | `statefulFakeDb` 补 `integration_external_systems` 的 COUNT 形态（建模"零引用"），因为 `removeDataSource` 现在会先查引用 |
