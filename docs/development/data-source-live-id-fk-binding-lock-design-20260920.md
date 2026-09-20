# 数据源删除 × 绑定：绑定侧参与持久化锁协议（PR-B：live_id 生成列 + FK 重指 + 取消 force）

- 日期：2026-09-20
- 任务：W7-B PR-B（#5784 owner 保留②的第二刀）
- 基线：`origin/main` = `6ea19e2de`（已含 PR-A #5889 的 squash 合并，PR-A 分支最终 `0648eb26c`：三份 fake 表严格）
- 前一刀：`docs/development/data-source-remove-transactional-lock-design-20260920.md`（PR-A：删除侧事务化 + FOR UPDATE）
- **owner 裁决（2026-09-20）：force 语义 = ① 取消 force。** 有引用即不可删，由数据库兜底；平台管理员要删须先解绑。
- 相关：#5784（先写库后清内存）、#5401（引用守卫 + 原 force 逃生门）、#5783（legacy 重绑必须同写 canonical）、minimal-plan §5 PR-2（L212-L213）

> **本刀后的准确表述**：并发删除隔离对 **canonical 形态**（`integration_external_systems.connection_id`）成立——两个时序都关闭、且由数据库而非应用层保证。**legacy 形态**（`connection_id IS NULL` + `config.dataSourceId`）没有 FK，仍只被 PR-A 的 FOR UPDATE 关掉一半（时序 B），时序 A 仍敞开。见 §7。

---

## 1. 要解决的洞（沿用 PR-A 的机器证据）

PR-A 把删除侧的「引用计数 + 软删」合入一个以 `SELECT … FOR UPDATE` 开头的事务。原 FK `fk_integration_external_systems_connection_id`（`connection_id → data_sources(id)`，`zzzz20260902120000_add_integration_connection_binding.ts:119-120`）让绑定侧在 INSERT/UPDATE 时对被引用行取 **KEY SHARE** 锁，与 FOR UPDATE 冲突，所以两侧确实串行化。但**软删只改 `deleted_at` / `is_active`，都不是 FK 引用的键列**：等待中的绑定醒来后，FK 复查只问「这个 id 的行还在吗」——在。悬空引用照样落地。PG 16.9 实测（PR-A 设计 §3 时序 A）：终态 `es1 → ds1(soft_deleted=t)`。

## 2. 做法：让软删对 FK 可见

```sql
ALTER TABLE data_sources
  ADD COLUMN live_id TEXT GENERATED ALWAYS AS (CASE WHEN deleted_at IS NULL THEN id END) STORED;
CREATE UNIQUE INDEX uq_data_sources_live_id ON data_sources (live_id);

ALTER TABLE integration_external_systems
  ADD CONSTRAINT fk_integration_external_systems_live_connection_id
  FOREIGN KEY (connection_id) REFERENCES data_sources(live_id)
  ON DELETE RESTRICT NOT VALID;
ALTER TABLE integration_external_systems
  DROP CONSTRAINT fk_integration_external_systems_connection_id;
```

迁移文件：`packages/core-backend/src/db/migrations/zzzz20260920120000_data_source_live_id_binding_lock.ts`（幂等；`down()` 恢复 `connection_id → data_sources(id)` 的 FK（同样 NOT VALID，理由见文件注释）并删索引与生成列）。

三个后果，全是要的：

1. **软删变成 key update**：`live_id` 从 `id` 变为 NULL，PG 取与 KEY SHARE 冲突的锁 → 绑定侧成为真正的参与者，**插件一行 SQL 不加、`lib/db.cjs` 的 `integration_` 表名白名单一点不放宽**（禁止项）。
2. **等在删除后面的绑定醒来时 FK 复查找不到 `live_id`** → SQLSTATE 23503，约束名 `fk_integration_external_systems_live_connection_id`。悬空行数 = 0。
3. **有 canonical 引用时，软删本身被数据库拒绝**（同一约束、同一 SQLSTATE，触发在 `UPDATE data_sources` 上；FK 未声明 `ON UPDATE` 动作，默认 NO ACTION）。这就是 `force=true` 在新 FK 下「根本做不到」的原因——owner 据此裁决取消 force，而不是让 FK `ON UPDATE CASCADE/SET NULL` 去静默改写绑定行。

### 为什么 NOT VALID
库里**已经**存在的悬空行（本守卫诞生前积累的，含每一次历史 force 删除）会让带校验的 `ADD CONSTRAINT` 失败、卡住部署。NOT VALID 只跳过对**存量**行的扫描；此后每一条**写入 `connection_id` 的** INSERT/UPDATE 都完整检查、完整取锁（PG 的子表 RI 检查只在 FK 列被写入时触发：一条存量悬空行若只更新别的列——`external-systems.cjs` update 分支只在 payload 带 `connectionId` 时才写该列——不会被复查、仍保持悬空，这与「存量行原样保留」的意图一致）。存量悬空行**原样保留**，留给 owner 可见的单独清理，不在迁移里静默改写。实测：预置 `es_stale → ds_dead(已软删)` 后迁移通过、该行保留、新的悬空插入被拒。

### 不是放宽
`ON DELETE RESTRICT` 保留：硬删一个**活着**且被引用的源仍被数据库拒绝。硬删一个**已软删**的源不再撞 RESTRICT（其 `live_id` 为 NULL，无人引用）——与应用语义一致：这种源已经没了，它残留的绑定正是 NOT VALID 容忍的存量行。

### 非键列更新不受影响
`updateStatus` 等只改 `status` / `last_connected_at` 的 UPDATE 不改 `live_id`，PG 取 FOR NO KEY UPDATE，与 KEY SHARE 不冲突 → 并发绑定不会被状态刷新卡住。实测见验证记录 §3 第 9 组。

## 3. 取消 force（owner 裁决 ①）

| 位置 | 之前 | 现在 |
|---|---|---|
| `DataSourceManager.removeDataSource(id, options)` | `options.force === true` 跳过计数（锁仍取） | 签名去掉 `force`；计数**恒跑**（事务内与无 db 旁路都是）；多余的选项键被忽略，所以旧调用方传 `{ force: true }` 得到的是同一个 409 |
| 409 文案 | 「…A platform admin may repeat the request with force=true…」 | 「…unbind them first — 请先解绑 N 个外部系统。Deleting a referenced source is refused; force=true is no longer accepted.」`details.referenceCount` 保留 |
| `routes/data-sources.ts` DELETE | 读 `?force=true`；非管理员 403 `DATA_SOURCE_FORCE_DELETE_ADMIN_ONLY`；管理员透传 `{ force }` 并审计 `forcedReferenceBreak` | 不读 force；任何层级引用存在 → 同一个 409；`removeDataSource(id)` 无选项；审计不再有 `forcedReferenceBreak`；manager 抛出的 coded 409 现在把 `details` 一并透出（之前 `codedGateRefusal` 只带 code/message） |
| `DATA_SOURCE_FORCE_DELETE_ADMIN_ONLY_CODE` | 导出常量 | 删除 |
| 数据库兜底 | 无 | manager `catch` 里按 **SQLSTATE 23503**（主判）+ 约束名（次判，缺省也接受，因为没有其它 RESTRICT FK 指向 `data_sources`）把软删/硬删自己撞 FK 翻成同一个 409（`details.referenceCount: null`，因为事务已中止、计数未知）；其它 23503 仍走值面干净的 500 `DATA_SOURCE_DELETE_NOT_PERSISTED` |
| openapi `DELETE /api/data-sources/{id}` | `force` query 参数 | 标 `deprecated: true`，描述写明已退役并被忽略；`src/paths/data-sources.yml` 与 `dist/*` 同步 |
| 前端 | 本就没有 force 开关（`DataSourcesPanel.vue` / `deleteRefusalCopy.ts` 明确不暴露） | 只改注释与 spec 里的服务器文案 fixture；操作路径不变：先到「已配置连接」解绑 |

**不按英文散文判**：仓库记忆（PG locale 守卫横扫）——222 是中文 locale，`violates foreign key constraint` 这串英文根本不会出现。`isLiveConnectionFkViolation`（manager）与 `translateConnectionFkViolation`（插件）都只看 `code` / `constraint`；单测里的假驱动错误刻意用中文散文。

## 4. 绑定侧的错误映射（插件）

`plugins/plugin-integration-core/lib/external-systems.cjs`：

- `upsertExternalSystem` 的 `db.updateRow(...)`（原 :776）与 `db.insertOne(...)`（原 :818）各加一个 `.catch(e => { throw translateConnectionFkViolation(e) })`。
- `translateConnectionFkViolation`：`code === '23503'` 且约束名 ∈ {`fk_integration_external_systems_live_connection_id`, `fk_integration_external_systems_connection_id`(迁移前) } 或缺省 → `ExternalSystemConflictError`（`inferHttpStatus` 按 `/Conflict/` → 409），`code = 'EXTERNAL_SYSTEM_CONNECTION_NOT_LIVE'`，`details = { field: 'connectionId', constraint }`。其它 23503 / 其它 SQLSTATE 原样透传。
- 为什么 code 不以 `DATA_SOURCE_` 开头：`http-routes.cjs` 的 `inferDataSourceBridgeErrorCode` 把 `^DATA_SOURCE_` 前缀的 code 一律映成 **422**；这是绑定与删除的**冲突**，应为 409。
- 导出：`EXTERNAL_SYSTEM_CONNECTION_NOT_LIVE_CODE`；`__internals` 增加 `LIVE_CONNECTION_FK` / `LEGACY_CONNECTION_FK` / `translateConnectionFkViolation`。

## 5. 锁序与隔离级别（不变，摘自 PR-A）

两侧都是 **`data_sources` 行在先、`integration_external_systems` 在后**：删除侧显式 FOR UPDATE 后再读/写绑定表；绑定侧由 FK 在写绑定表时取 `data_sources` 的 KEY SHARE。同序 ⇒ 无循环等待。READ COMMITTED（PG 默认、部署实际级别）即可：保证建立在显式行锁 + FK 自身复查之上，不依赖快照语义。

## 6. 时序（新 FK 下，PG 16.9 实测，命令与输出见验证记录）

| 时序 | 会话 A（真 `DataSourceManager.removeDataSource`） | 会话 B（真插件 `upsertExternalSystem`，经真 `db.cjs`） | 结果 |
|---|---|---|---|
| A：删除在前 | FOR UPDATE → count=0 →（B 在此阻塞 ≥800ms）→ UPDATE deleted_at → COMMIT | INSERT 阻塞 → 恢复 → FK 复查失败 | B 收到 409 `EXTERNAL_SYSTEM_CONNECTION_NOT_LIVE`；新增悬空行 0 |
| B：绑定在前 | FOR UPDATE 阻塞 ≥800ms → B 提交后 count=1 → 抛 409 | BEGIN；INSERT（持 KEY SHARE）… COMMIT | A 收到 409 `DATA_SOURCE_REFERENCED_BY_EXTERNAL_SYSTEMS`，`referenceCount: 1`，行未软删，内存未清 |
| force | `removeDataSource(id, { force: true })` | （已有引用） | 409；行未软删。直接 `UPDATE data_sources SET deleted_at=now()` → 23503 on live FK |
| 兜底 | 人为让 count 返回 0 | （已有引用） | UPDATE 撞 FK → manager 映成 409，`referenceCount: null`，行未软删 |

## 7. 覆盖矩阵

| # | 写入口 | 位置 | 状态 |
|---|---|---|---|
| 1 | `upsertExternalSystem` INSERT | `external-systems.cjs` insert 分支 | **covered（canonical）**：时序 A 由 live FK 拒绝，时序 B 由 FOR UPDATE + 事务内计数拒绝 |
| 2 | `upsertExternalSystem` UPDATE（重绑） | 同上 update 分支 | **covered（canonical）**，同 #1；错误映射同样接线 |
| 3 | `deleteExternalSystem` | `external-systems.cjs` | n/a：减少引用 |
| 4 | 切换迁移 backfill | `zzzz20260902120000:97-105` | covered：离线一次性 |
| 5 | `DELETE/PUT /api/admin/data/bulk` 以 `data_sources` 为目标（PUT 可直接 set `deleted_at`） | `routes/admin-routes.ts` 两条 `/data/bulk` | **covered（canonical）——本刀之后由 H2 收口**：两条路由各加①预检（按 filters 解析目标 id → 查 canonical `connection_id` 引用，有引用则写前 409 并带 `ids`）与②兜底（catch 里复用 `isLiveConnectionFkViolation`，23503 + 约束名 → 同一个 409 `DATA_SOURCE_REFERENCED_BY_EXTERNAL_SYSTEMS`，`details={table,ids}`）。别的约束的 23503、别的目标表、非 23503 一律保持原状态码。设计/验证见 `docs/development/admin-bulk-data-sources-fk-409-design-20260920.md`。legacy 形态与其它持指针的表仍不在覆盖内（下方登记不变） |

**uncovered（已登记，本刀明确不关）：**

- **legacy 形态** `config.dataSourceId`（`connection_id IS NULL`）：没有 FK，`live_id` 机制对它无效。删除侧的计数（P2-A owner 归属戳）+ FOR UPDATE 仍挡住时序 B；时序 A 仍敞开。关闭它需要 legacy 行也带 `connection_id`（#5783 的方向）或单独的 CHECK/触发器，属后续。
- **其它持 dataSourceId 指针但删除守卫不计数的表**：`integration_stock_prep_source_binding`（079）、read-source-config store 等。它们不在 `countExternalSystemReferences` 里，也没有指向 `data_sources` 的 FK，删除守卫与本 FK 都看不见——既有缺口，非本刀引入。
- **存量悬空行**：NOT VALID 容忍、原样保留；`VALIDATE CONSTRAINT` 需先清理，属 owner 可见的单独动作。
- **硬删**：RESTRICT 保护不变；未新增也未削弱。
- **兜底映射的口径**：`DataSourceManager.ts` 的 `isLiveConnectionFkViolation` 在约束名缺失时把任意 23503 当引用 409，前提是今天没有其它 RESTRICT/NO ACTION FK 指向 `data_sources`（`20251206000001_create_data_sources_table.ts:114/183`、`migrations/040_data_sources.sql` 全部 `ON DELETE CASCADE`，079 明确不建 FK）。这个前提没有绊线；后人若加一条 RESTRICT FK 指向 `data_sources`，需同步收窄该映射（按约束名主判）。

## 8. 部署顺序与回滚

- **先迁移后发版。** 旧应用 + 新 schema：只失去 force 路径（数据库 23503 → 旧 manager 会翻成 500 `DATA_SOURCE_DELETE_NOT_PERSISTED`，值面干净、行未动）；新应用 + 旧 schema：保留 PR-A 的全部保证、只少时序 A 的兜底（manager 的 23503 映射静默不触发）。
- **回滚 = `down()`**：FK 回到 `connection_id → data_sources(id)`（NOT VALID），删索引与生成列。迁移期间已按新 FK 拒绝的绑定不需要补偿——它们从未落地。
- `migrate.ts:32 allowUnorderedMigrations=true`；文件名时间戳 `zzzz20260920120000` 晚于目录里最新的 `zzzz20260919130000`。

## 9. 未改动

`http-routes.cjs`、`package.json`、`.github/`、`lib/db.cjs` 的表白名单、任何 legacy 形态的存储、`integration_stock_prep_source_binding`——均未触碰。
